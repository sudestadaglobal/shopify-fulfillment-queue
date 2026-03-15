#!/usr/bin/env node

const https = require('https');
const fs = require('fs');

const CONFIG = {
  shop: 'sudestadaglobal.myshopify.com',
  accessToken: process.env.SHOPIFY_TOKEN,
  apiVersion: '2024-01',
  rtffTag: 'RTFF',
  perProductLimit: 3,        // max orders per product per run
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Shopify data fetchers ────────────────────────────────────────────────────

async function getAllUnfulfilledOrders() {
  const orders = [];
  let path = `/orders.json?fulfillment_status=unfulfilled&status=open&order=created_at+asc&limit=250`;

  while (path) {
    const { data, headers } = await shopifyRequest(path);
    orders.push(...(data.orders || []));

    const link = headers['link'] || '';
    const next = link.match(/<[^>]*\/orders\.json(\?[^>]*)>;\s*rel="next"/);
    path = next ? `/orders.json${next[1]}` : null;
  }

  return orders;
}

async function getVariantDetails(variantIds) {
  const map = {}; // variantId -> { inventoryItemId, title, productId }
  const chunks = chunk(variantIds, 100);

  for (const c of chunks) {
    const { data } = await shopifyRequest(
      `/variants.json?ids=${c.join(',')}&limit=250&fields=id,inventory_item_id,title,product_id`
    );
    for (const v of data.variants || []) {
      map[v.id] = {
        inventoryItemId: v.inventory_item_id,
        title: v.title,
        productId: v.product_id,
      };
    }
    await sleep(200);
  }

  return map;
}

async function getInventoryLevels(inventoryItemIds) {
  const levels = {}; // inventoryItemId -> total available (across all locations)
  const chunks = chunk(inventoryItemIds, 50);

  for (const c of chunks) {
    const { data } = await shopifyRequest(
      `/inventory_levels.json?inventory_item_ids=${c.join(',')}&limit=250`
    );
    for (const level of data.inventory_levels || []) {
      const id = level.inventory_item_id;
      levels[id] = (levels[id] || 0) + (level.available || 0);
    }
    await sleep(200);
  }

  return levels;
}

async function getProductTitles(productIds) {
  const titles = {};
  const chunks = chunk(productIds, 100);

  for (const c of chunks) {
    const { data } = await shopifyRequest(
      `/products.json?ids=${c.join(',')}&limit=250&fields=id,title`
    );
    for (const p of data.products || []) {
      titles[p.id] = p.title;
    }
    await sleep(200);
  }

  return titles;
}

async function updateOrderTags(orderId, currentTags, shouldHaveRTFF) {
  const tagSet = new Set(
    currentTags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
  );
  const hadRTFF = tagSet.has(CONFIG.rtffTag);

  if (shouldHaveRTFF === hadRTFF) return; // no change

  if (shouldHaveRTFF) tagSet.add(CONFIG.rtffTag);
  else tagSet.delete(CONFIG.rtffTag);

  await shopifyRequest(`/orders/${orderId}.json`, 'PUT', {
    order: { id: orderId, tags: [...tagSet].join(', ') },
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

  // 2. Collect unique variant IDs across all orders
  const variantIds = uniqueIds(
    orders.flatMap((o) => o.line_items.map((i) => i.variant_id).filter(Boolean))
  );

  // 3. Enrich: variant → inventoryItemId, inventory levels, product names
  console.log('🔍 Fetching inventory & product data...');
  const variantMap = await getVariantDetails(variantIds);

  const inventoryItemIds = uniqueIds(
    Object.values(variantMap).map((v) => v.inventoryItemId)
  );
  const inventoryLevels = await getInventoryLevels(inventoryItemIds);

  const productIds = uniqueIds(Object.values(variantMap).map((v) => v.productId));
  const productTitles = await getProductTitles(productIds);

  // Helper: resolve product label from variantId
  function label(variantId) {
    const v = variantMap[variantId];
    if (!v) return `Variant #${variantId}`;
    const product = productTitles[v.productId] || `Product #${v.productId}`;
    return v.title && v.title !== 'Default Title' ? `${product} — ${v.title}` : product;
  }

  // 4. Stock allocation (oldest-first, all-or-nothing per order)
  console.log('🧮 Allocating stock...');

  const available = { ...inventoryLevels }; // mutable working copy
  const productOrderCount = {}; // inventoryItemId → # orders already allocated

  const fulfillableOrders = [];
  const blockedOrders = [];

  for (const order of orders) {
    let canFulfill = true;
    const blockReasons = [];

    for (const item of order.line_items) {
      if (!item.variant_id) continue;
      const v = variantMap[item.variant_id];
      if (!v) continue;

      const stock = available[v.inventoryItemId] ?? 0;
      const needed = item.quantity;
      const orderCount = productOrderCount[v.inventoryItemId] ?? 0;

      if (orderCount >= CONFIG.perProductLimit) {
        canFulfill = false;
        blockReasons.push({
          product: label(item.variant_id),
          reason: `Per-product limit reached (${CONFIG.perProductLimit} orders)`,
          stock,
          needed,
        });
      } else if (stock < needed) {
        canFulfill = false;
        blockReasons.push({
          product: label(item.variant_id),
          reason: 'Insufficient stock',
          stock,
          needed,
        });
      }
    }

    if (canFulfill) {
      // Commit the allocation
      for (const item of order.line_items) {
        if (!item.variant_id) continue;
        const v = variantMap[item.variant_id];
        if (!v) continue;
        available[v.inventoryItemId] = (available[v.inventoryItemId] ?? 0) - item.quantity;
        productOrderCount[v.inventoryItemId] = (productOrderCount[v.inventoryItemId] ?? 0) + 1;
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
        createdAt: order.created_at,
        itemCount: order.line_items.length,
        reasons: blockReasons,
      });
    }
  }

  console.log(`   → ${fulfillableOrders.length} fulfillable, ${blockedOrders.length} blocked`);

  // 5. Sync RTFF tags in Shopify
  console.log('🏷️  Syncing RTFF tags...');
  const fulfillableIds = new Set(fulfillableOrders.map((o) => o.id));
  let tagged = 0;
  let untagged = 0;

  for (const order of orders) {
    const should = fulfillableIds.has(order.id);
    const has = order.tags.includes(CONFIG.rtffTag);

    if (should !== has) {
      await updateOrderTags(order.id, order.tags, should);
      await sleep(250);
      should ? tagged++ : untagged++;
    }
  }

  console.log(`   → +${tagged} tagged, -${untagged} untagged`);

  // 6. Compute stock alerts
  // Total demand across ALL unfulfilled orders (not just fulfillable ones)
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
    const stock = inventoryLevels[invId] ?? 0;
    const productLabel = label(variantId);

    if (demand > stock) {
      demandExceedsStock.push({
        product: productLabel,
        stock,
        demand,
        shortfall: demand - stock,
      });
    }

    if (stock >= 0 && stock < CONFIG.lowStockThreshold) {
      lowStock.push({ product: productLabel, stock, demand });
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
