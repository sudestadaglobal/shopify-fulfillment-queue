#!/usr/bin/env node

const https = require('https');
const fs = require('fs');

const CONFIG = {
  shop: 'sudestadaglobal.myshopify.com',
  accessToken: process.env.SHOPIFY_TOKEN,
  apiVersion: '2026-01',
  rtffTag: 'RTFF',
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

async function getVariantDetails(variantIds, productIds) {
  const map = {}; // variantId -> { inventoryItemId, title, productId }

  // Fetch products (which include their variants with inventory_item_id)
  const uniqueProductIds = [...new Set(productIds)];
  const chunks_ = chunk(uniqueProductIds, 50);

  for (const c of chunks_) {
    const { data } = await shopifyRequest(
      `/products.json?ids=${c.join(',')}&limit=250&status=any&fields=id,title,variants`
    );
    for (const product of data.products || []) {
      for (const v of product.variants || []) {
        map[v.id] = {
          inventoryItemId: v.inventory_item_id,
          title: v.title,
          productId: product.id,
        };
      }
    }
    await sleep(200);
  }

  // Fallback: fetch any variants still missing (e.g. deleted products)
  const missing = variantIds.filter((id) => !map[id]);
  if (missing.length > 0) {
    console.log(`   ⚠️ ${missing.length} variant(s) not found via products, fetching individually...`);
    for (const vid of missing) {
      try {
        const { data } = await shopifyRequest(`/variants/${vid}.json`);
        if (data.variant) {
          map[vid] = {
            inventoryItemId: data.variant.inventory_item_id,
            title: data.variant.title,
            productId: data.variant.product_id,
          };
        }
      } catch (e) {
        console.log(`     → Variant ${vid} not found, will block orders containing it`);
      }
      await sleep(200);
    }
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
      `/products.json?ids=${c.join(',')}&limit=250&status=any&fields=id,title`
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

  // 2. Collect unique variant IDs and product IDs across all orders
  const variantIds = uniqueIds(
    orders.flatMap((o) => o.line_items.map((i) => i.variant_id).filter(Boolean))
  );
  const orderProductIds = uniqueIds(
    orders.flatMap((o) => o.line_items.map((i) => i.product_id).filter(Boolean))
  );

  // 3. Enrich: variant → inventoryItemId, inventory levels, product names
  console.log('🔍 Fetching inventory & product data...');
  const variantMap = await getVariantDetails(variantIds, orderProductIds);

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

  const fulfillableOrders = [];
  const blockedOrders = [];

  for (const order of orders) {
    let canFulfill = true;
    const blockReasons = [];

    for (const item of order.line_items) {
      // Skip items we can't verify (custom items, deleted products, tips, etc.)
      // Only check stock for items we CAN resolve — team verifies the rest manually
      if (!item.variant_id || !variantMap[item.variant_id]) {
        continue;
      }

      const v = variantMap[item.variant_id];
      const stock = available[v.inventoryItemId] ?? 0;
      const needed = item.quantity;

      if (stock < needed) {
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
      // Commit the allocation — deduct stock so next orders see reduced availability
      for (const item of order.line_items) {
        if (!item.variant_id) continue;
        const v = variantMap[item.variant_id];
        if (!v) continue;
        available[v.inventoryItemId] = (available[v.inventoryItemId] ?? 0) - item.quantity;
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

  // Debug: log first few fulfillable and blocked
  for (const o of fulfillableOrders.slice(0, 5)) {
    console.log(`     ✅ ${o.name} (${o.itemCount} items)`);
  }
  for (const o of blockedOrders.slice(0, 5)) {
    console.log(`     ❌ ${o.name}: ${o.reasons.map((r) => `${r.product} — ${r.reason} (need ${r.needed}, have ${r.stock})`).join('; ')}`);
  }

  // 5. Sync RTFF tags in Shopify
  // Step A: Remove RTFF from ALL unfulfilled orders that have it
  console.log('🏷️  Cleaning RTFF tags from all unfulfilled orders...');
  let untagged = 0;
  for (const order of orders) {
    if (order.tags.includes(CONFIG.rtffTag)) {
      await updateOrderTags(order.id, order.tags, false);
      await sleep(250);
      untagged++;
    }
  }
  console.log(`   → Removed RTFF from ${untagged} order(s)`);

  // Step B: Re-fetch tags (they changed above), then add RTFF only to fulfillable orders
  console.log('🏷️  Adding RTFF to fulfillable orders...');
  const fulfillableIds = new Set(fulfillableOrders.map((o) => o.id));
  let tagged = 0;
  for (const order of orders) {
    if (fulfillableIds.has(order.id)) {
      // Re-read the order's current tags since we may have just removed RTFF
      const currentTags = order.tags
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t && t !== CONFIG.rtffTag)
        .join(', ');
      await updateOrderTags(order.id, currentTags, true);
      await sleep(250);
      tagged++;
    }
  }
  console.log(`   → Added RTFF to ${tagged} order(s)`);

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
