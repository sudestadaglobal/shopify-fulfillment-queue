#!/usr/bin/env node

const https = require('https');
const fs = require('fs');

const CONFIG = {
  shop: 'sudestadaglobal.myshopify.com',
  accessToken: process.env.SHOPIFY_TOKEN,
  apiVersion: '2026-01',
  rtffTag: 'RTFF',
  perProductLimit: 3,        // max orders allocated per variant per run (0 = unlimited)
  lowStockThreshold: 10,     // items below this quantity flagged as low stock
};

// ─── HTTP helper ─────────────────────────────────────────────────────────────

function shopifyRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: CONFIG.shop,
      path: `/admin/api/${CONFIG.apiVersion}${path}`,
      method,
      headers: {
        'X-Shopify-Access-Token': CONFIG.accessToken,
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ data: JSON.parse(data), headers: res.headers, status: res.statusCode });
        } catch (e) {
          reject(new Error(`Parse error (${res.statusCode}): ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Wraps shopifyRequest with automatic 429 retry (Shopify leaky-bucket rate limit).
async function shopifyFetch(path, method = 'GET', body = null, maxRetries = 5) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await shopifyRequest(path, method, body);

    if (result.status === 429) {
      const wait = parseInt(result.headers['retry-after'] || '2', 10) * 1000;
      console.log(`   ⏳ Rate limited — retrying in ${wait / 1000}s (attempt ${attempt + 1}/${maxRetries})...`);
      await sleep(wait);
      continue;
    }

    return result;
  }
  throw new Error(`shopifyFetch: too many retries for ${path}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Shopify data fetchers ────────────────────────────────────────────────────

// Robustly extracts the "next" path from a Shopify Link header.
function parseLinkHeader(link, apiVersion) {
  const match = link.match(/<([^>]+)>;\s*rel="next"/);
  if (!match) return null;
  const url = new URL(match[1]);
  return url.pathname.replace(`/admin/api/${apiVersion}`, '') + url.search;
}

async function getAllUnfulfilledOrders() {
  const orders = [];
  let path = `/orders.json?fulfillment_status=unfulfilled&status=open&order=created_at+asc&limit=250`;

  while (path) {
    const { data, headers } = await shopifyFetch(path);
    orders.push(...(data.orders || []));
    path = parseLinkHeader(headers['link'] || '', CONFIG.apiVersion);
  }

  return orders;
}

// Fetches variant→inventoryItemId mapping AND product titles in one pass,
// eliminating the need for a separate getProductTitles() call.
async function getVariantDetails(variantIds, productIds) {
  const variantMap = {};    // variantId  → { inventoryItemId, title, productId }
  const productTitles = {}; // productId  → title

  for (const c of chunk([...new Set(productIds)], 50)) {
    const { data } = await shopifyFetch(
      `/products.json?ids=${c.join(',')}&limit=250&status=any&fields=id,title,variants`
    );
    for (const product of data.products || []) {
      productTitles[product.id] = product.title;
      for (const v of product.variants || []) {
        variantMap[v.id] = {
          inventoryItemId: v.inventory_item_id,
          title: v.title,
          productId: product.id,
        };
      }
    }
    await sleep(200);
  }

  // Fallback: fetch any variants still missing (e.g. deleted products)
  const missing = variantIds.filter((id) => !variantMap[id]);
  if (missing.length > 0) {
    console.log(`   ⚠️ ${missing.length} variant(s) not found via products, fetching individually...`);
    for (const vid of missing) {
      try {
        const { data } = await shopifyFetch(`/variants/${vid}.json`);
        if (data.variant) {
          const v = data.variant;
          variantMap[vid] = {
            inventoryItemId: v.inventory_item_id,
            title: v.title,
            productId: v.product_id,
          };
          // Fetch product title if not already cached
          if (!productTitles[v.product_id]) {
            const { data: pd } = await shopifyFetch(`/products/${v.product_id}.json?fields=id,title`);
            if (pd.product) productTitles[pd.product.id] = pd.product.title;
          }
        }
      } catch (e) {
        console.log(`     → Variant ${vid} not found, will skip stock check for orders containing it`);
      }
      await sleep(200);
    }
  }

  return { variantMap, productTitles };
}

// Runs a GraphQL query against the Shopify Admin API.
async function shopifyGraphQL(query, variables = {}) {
  const { data: body } = await shopifyFetch('/graphql.json', 'POST', { query, variables });
  if (body.errors) throw new Error(`GraphQL: ${body.errors[0]?.message}`);
  return body.data;
}

// Returns on_hand, committed, and incoming quantities per inventoryItemId (summed across all locations).
// Uses on_hand (physical units in warehouse) rather than available (on_hand - committed),
// so the allocation engine works from real stock counts, not Shopify's pre-committed figures.
async function getInventoryQuantities(inventoryItemIds) {
  const onHand    = {}; // inventoryItemId → physical units in warehouse
  const committed = {}; // inventoryItemId → units reserved for open orders
  const incoming  = {}; // inventoryItemId → units on their way

  for (const c of chunk(inventoryItemIds, 50)) {
    const ids = c.map((id) => `gid://shopify/InventoryItem/${id}`);
    const data = await shopifyGraphQL(
      `query($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on InventoryItem {
            id
            inventoryLevels(first: 20) {
              edges {
                node {
                  quantities(names: ["on_hand", "committed", "incoming"]) { name quantity }
                }
              }
            }
          }
        }
      }`,
      { ids }
    );

    for (const node of data?.nodes ?? []) {
      if (!node?.id) continue;
      const numericId = parseInt(node.id.split('/').pop(), 10);
      let hand = 0, comm = 0, inc = 0;
      for (const edge of node.inventoryLevels?.edges ?? []) {
        for (const qty of edge.node.quantities ?? []) {
          if (qty.name === 'on_hand')   hand += qty.quantity;
          if (qty.name === 'committed') comm += qty.quantity;
          if (qty.name === 'incoming')  inc  += qty.quantity;
        }
      }
      onHand[numericId]     = hand;
      committed[numericId]  = comm;
      incoming[numericId]   = inc;
    }
    await sleep(300);
  }

  return { onHand, committed, incoming };
}

// Updates RTFF tag and the custom.stockstatus metafield in a single PUT call.
// missingItems: array of { product, needed, stock } — empty array clears the metafield.
async function syncOrderState(orderId, currentTags, shouldHaveRTFF, missingItems) {
  const tagSet = new Set(
    currentTags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
  );
  if (shouldHaveRTFF) tagSet.add(CONFIG.rtffTag);
  else tagSet.delete(CONFIG.rtffTag);

  const metafieldValue = missingItems.length > 0
    ? missingItems.map((r) => `${r.product}: need ${r.needed}, have ${r.stock}`).join('\n')
    : '';

  await shopifyFetch(`/orders/${orderId}.json`, 'PUT', {
    order: {
      id: orderId,
      tags: [...tagSet].join(', '),
      metafields: [{
        namespace: 'custom',
        key: 'stockstatus',
        type: 'multi_line_text_field',
        value: metafieldValue,
      }],
    },
  });
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function uniqueIds(arr) {
  return [...new Set(arr)];
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 Shopify Fulfillment Queue starting...\n');

  if (!CONFIG.accessToken) {
    console.error('❌ SHOPIFY_TOKEN is not set.');
    process.exit(1);
  }

  // 1. Fetch all unfulfilled orders (oldest first)
  console.log('📦 Fetching unfulfilled orders...');
  const orders = await getAllUnfulfilledOrders();
  console.log(`   → ${orders.length} unfulfilled orders found`);

  if (orders.length === 0) {
    writeReport({
      generatedAt: new Date().toISOString(),
      summary: { totalUnfulfilled: 0, canFulfill: 0, blocked: 0 },
      fulfillableOrders: [],
      blockedOrders: [],
      stockAlerts: { lowStock: [], demandExceedsStock: [] },
    });
    console.log('✅ Nothing to do.');
    return;
  }

  // 2. Collect unique variant IDs and product IDs across all orders
  const variantIds = uniqueIds(
    orders.flatMap((o) => o.line_items.map((i) => i.variant_id).filter(Boolean))
  );
  const orderProductIds = uniqueIds(
    orders.flatMap((o) => o.line_items.map((i) => i.product_id).filter(Boolean))
  );

  // 3. Enrich: variant → inventoryItemId + product titles (single API pass), then inventory levels
  console.log('🔍 Fetching inventory & product data...');
  const { variantMap, productTitles } = await getVariantDetails(variantIds, orderProductIds);

  const inventoryItemIds = uniqueIds(
    Object.values(variantMap).map((v) => v.inventoryItemId)
  );
  const { onHand, committed: committedLevels, incoming: incomingLevels } = await getInventoryQuantities(inventoryItemIds);

  // Helper: resolve a human-readable label from variantId
  function label(variantId) {
    const v = variantMap[variantId];
    if (!v) return `Variant #${variantId}`;
    const product = productTitles[v.productId] || `Product #${v.productId}`;
    return v.title && v.title !== 'Default Title' ? `${product} — ${v.title}` : product;
  }

  // 4. Stock allocation (oldest-first, all-or-nothing per order)
  console.log('🧮 Allocating stock...');

  const available = { ...onHand }; // mutable working copy seeded from on_hand
  const orderCountPerItem = {};             // inventoryItemId → # orders allocated so far

  const fulfillableOrders = [];
  const blockedOrders = [];

  for (const order of orders) {
    let canFulfill = true;
    const blockReasons = [];

    for (const item of order.line_items) {
      // Skip unresolvable items (custom items, tips, deleted products, etc.)
      // Also skip items with no fulfillable quantity (removed/edited line items)
      if (!item.variant_id || !variantMap[item.variant_id]) continue;
      if ((item.fulfillable_quantity ?? item.quantity) === 0) continue;

      const v = variantMap[item.variant_id];
      const stock = available[v.inventoryItemId] ?? 0;
      const needed = item.quantity;
      const orderCount = orderCountPerItem[v.inventoryItemId] ?? 0;

      if (stock < needed) {
        canFulfill = false;
        blockReasons.push({
          product: label(item.variant_id),
          reason: 'Insufficient stock',
          stock,
          needed,
        });
      } else if (CONFIG.perProductLimit > 0 && orderCount >= CONFIG.perProductLimit) {
        canFulfill = false;
        blockReasons.push({
          product: label(item.variant_id),
          reason: `Per-product limit reached (max ${CONFIG.perProductLimit} orders per run)`,
          stock,
          needed,
        });
      }
    }

    if (canFulfill) {
      // Commit the allocation — deduct stock and increment per-item order count
      for (const item of order.line_items) {
        if (!item.variant_id) continue;
        if ((item.fulfillable_quantity ?? item.quantity) === 0) continue;
        const v = variantMap[item.variant_id];
        if (!v) continue;
        available[v.inventoryItemId] = (available[v.inventoryItemId] ?? 0) - item.quantity;
        orderCountPerItem[v.inventoryItemId] = (orderCountPerItem[v.inventoryItemId] ?? 0) + 1;
      }
      fulfillableOrders.push({
        id: order.id,
        name: order.name,
        createdAt: order.created_at,
        itemCount: order.line_items.length,
      });
    } else {
      blockedOrders.push({
        id: order.id,
        name: order.name,
        customerName: order.customer
          ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim()
          : '',
        createdAt: order.created_at,
        itemCount: order.line_items.length,
        reasons: blockReasons,
      });
    }
  }

  console.log(`   → ${fulfillableOrders.length} fulfillable, ${blockedOrders.length} blocked`);

  for (const o of fulfillableOrders.slice(0, 5)) {
    console.log(`     ✅ ${o.name} (${o.itemCount} items)`);
  }
  for (const o of blockedOrders.slice(0, 5)) {
    console.log(`     ❌ ${o.name}: ${o.reasons.map((r) => `${r.product} — ${r.reason} (need ${r.needed}, have ${r.stock})`).join('; ')}`);
  }

  // 5. Sync RTFF tag + MissingStock metafield for every unfulfilled order in one pass.
  //    Each order gets a single PUT that updates both tag and metafield together.
  //    Blocked orders get their missing items written to custom.stockstatus;
  //    fulfillable orders get the metafield cleared.
  console.log('🏷️  Syncing tags & metafields...');
  const fulfillableIds = new Set(fulfillableOrders.map((o) => o.id));
  const blockedReasonsMap = new Map(blockedOrders.map((o) => [o.id, o.reasons]));
  let tagged = 0, untagged = 0;

  for (const order of orders) {
    const shouldHaveRTFF = fulfillableIds.has(order.id);
    const hadRTFF = order.tags.includes(CONFIG.rtffTag);
    const missingItems = blockedReasonsMap.get(order.id) || [];

    await syncOrderState(order.id, order.tags, shouldHaveRTFF, missingItems);
    await sleep(200);

    if (shouldHaveRTFF !== hadRTFF) {
      if (shouldHaveRTFF) tagged++; else untagged++;
    }
  }

  console.log(`   → Tagged ${tagged}, untagged ${untagged}, metafields synced on all ${orders.length} orders`);

  // 6. Compute stock alerts — total demand across ALL unfulfilled orders
  const totalDemand = {}; // inventoryItemId → { demand, variantId }
  for (const order of orders) {
    for (const item of order.line_items) {
      if (!item.variant_id) continue;
      const v = variantMap[item.variant_id];
      if (!v) continue;
      const id = v.inventoryItemId;
      if (!totalDemand[id]) totalDemand[id] = { demand: 0, variantId: item.variant_id };
      totalDemand[id].demand += item.quantity;
    }
  }

  const demandExceedsStock = [];
  const lowStock = [];

  for (const [invId, { demand, variantId }] of Object.entries(totalDemand)) {
    const hand     = onHand[invId]         ?? 0;
    const comm     = committedLevels[invId] ?? 0;
    const inc      = incomingLevels[invId]  ?? 0;
    const productLabel = label(variantId);
    const v = variantMap[variantId];

    // Show only items where even incoming stock won't cover committed orders —
    // i.e. items that actually need to be purchased/restocked.
    if ((hand + inc) < comm) {
      demandExceedsStock.push({
        product:   productLabel,
        productId: v?.productId,
        variantId: Number(variantId),
        onHand:    hand,
        committed: comm,
        incoming:  inc,
        available: hand - comm,           // can be negative
        shortfall: comm - (hand + inc),   // units still needed even after incoming arrives
      });
    }

    if (hand < CONFIG.lowStockThreshold) {
      lowStock.push({
        product:   productLabel,
        productId: v?.productId,
        variantId: Number(variantId),
        onHand:    hand,
        committed: comm,
        demand,
      });
    }
  }

  demandExceedsStock.sort((a, b) => b.shortfall - a.shortfall);
  lowStock.sort((a, b) => a.stock - b.stock);

  // 7. Write report
  const report = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalUnfulfilled: orders.length,
      canFulfill: fulfillableOrders.length,
      blocked: blockedOrders.length,
    },
    fulfillableOrders,
    blockedOrders,
    stockAlerts: { lowStock, demandExceedsStock },
  };

  writeReport(report);

  console.log('\n✅ Done!');
  if (demandExceedsStock.length) console.log(`⚠️  ${demandExceedsStock.length} item(s) — demand exceeds stock`);
  if (lowStock.length) console.log(`⚠️  ${lowStock.length} item(s) low on stock`);
  console.log(`📊 report.json written`);
}

function writeReport(report) {
  fs.writeFileSync('report.json', JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
