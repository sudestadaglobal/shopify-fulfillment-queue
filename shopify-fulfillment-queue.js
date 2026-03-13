/**
 * Shopify Fulfillment Queue
 * - Checks all line items per order — if ANY item lacks stock, order is blocked
 * - Tags ready orders with RTFF in Shopify, removes tag from orders no longer ready
 * - Oldest orders first; respects per-product fulfillment limit
 *
 * Setup:
 *   npm install node-fetch
 *   node shopify-fulfillment-queue.js
 *
 * Shopify app scopes needed:
 *   read_orders, write_orders, read_inventory, read_products
 */

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const CONFIG = {
  shop: 'sudestadaglobal.myshopify.com',
  accessToken: 'YOUR_ADMIN_API_TOKEN',
  apiVersion: '2024-01',
  rtffTag: 'RTFF',
  perProductLimit: 3, // max orders to fulfill per product in one run (set to Infinity to disable)
};

const BASE = `https://${CONFIG.shop}/admin/api/${CONFIG.apiVersion}`;
const HEADERS = {
  'X-Shopify-Access-Token': CONFIG.accessToken,
  'Content-Type': 'application/json',
};

// Shopify rate limit: ~2 req/s on Basic, 4/s on Advanced. We sleep between write calls.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function shopifyGet(path) {
  const res = await fetch(`${BASE}${path}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${res.statusText}`);
  return res.json();
}

async function shopifyPut(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PUT ${path} failed: ${res.status} ${res.statusText}`);
  return res.json();
}

// ─── Fetch all unfulfilled orders (oldest first) ────────────────────────────

async function getAllUnfulfilledOrders() {
  let orders = [];
  let url = `/orders.json?status=open&fulfillment_status=unfulfilled&limit=250&order=created_at+asc`;

  while (url) {
    const res = await fetch(`${BASE}${url}`, { headers: HEADERS });
    if (!res.ok) throw new Error(`Orders fetch failed: ${res.status}`);

    const linkHeader = res.headers.get('Link') || '';
    const data = await res.json();
    orders = orders.concat(data.orders);

    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1].replace(BASE, '') : null;
  }

  return orders;
}

// ─── Fetch inventory levels for all variants ────────────────────────────────

async function getStockByVariantId(variantIds) {
  const uniqueIds = [...new Set(variantIds.filter(Boolean))];
  if (uniqueIds.length === 0) return {};

  // Chunk into batches of 100 (Shopify limit)
  const chunks = [];
  for (let i = 0; i < uniqueIds.length; i += 100) chunks.push(uniqueIds.slice(i, i + 100));

  const variantToItemId = {};
  const allInventoryItemIds = [];

  for (const chunk of chunks) {
    const data = await shopifyGet(`/variants.json?ids=${chunk.join(',')}&limit=250`);
    for (const v of data.variants) {
      variantToItemId[v.id] = v.inventory_item_id;
      allInventoryItemIds.push(v.inventory_item_id);
    }
  }

  // Fetch inventory levels, chunked by 50
  const stockByItemId = {};
  const itemChunks = [];
  for (let i = 0; i < allInventoryItemIds.length; i += 50) itemChunks.push(allInventoryItemIds.slice(i, i + 50));

  for (const chunk of itemChunks) {
    const data = await shopifyGet(`/inventory_levels.json?inventory_item_ids=${chunk.join(',')}&limit=250`);
    for (const level of data.inventory_levels) {
      const id = level.inventory_item_id;
      stockByItemId[id] = (stockByItemId[id] || 0) + Math.max(0, level.available || 0);
    }
  }

  const result = {};
  for (const [variantId, itemId] of Object.entries(variantToItemId)) {
    result[variantId] = stockByItemId[itemId] || 0;
  }
  return result;
}

// ─── Build fulfillment queue ─────────────────────────────────────────────────
// Rules:
//  1. Process oldest orders first
//  2. ALL line items in an order must have sufficient stock → order is READY
//  3. If ANY line item is short → order is BLOCKED (shows which item is the bottleneck)
//  4. Per-product limit: once a product has been allocated to N orders, stop allocating it

function buildQueue(orders, stockByVariantId) {
  const runningStock = { ...stockByVariantId };
  const productOrderCount = {}; // variantId -> orders allocated so far this run

  return orders.map(order => {
    const lineResults = [];
    let blockedBy = null;

    for (const item of order.line_items) {
      const vid = item.variant_id;
      const needed = item.fulfillable_quantity;

      // Item already fulfilled — skip it
      if (needed === 0) {
        lineResults.push({ title: item.title, needed, available: null, status: 'already_fulfilled' });
        continue;
      }

      const available = runningStock[vid] ?? 0;
      const allocatedOrders = productOrderCount[vid] || 0;
      const limitReached = allocatedOrders >= CONFIG.perProductLimit;

      if (limitReached) {
        lineResults.push({ title: item.title, needed, available, status: 'limit_reached' });
        if (!blockedBy) blockedBy = `${item.title} (per-product limit of ${CONFIG.perProductLimit} reached)`;
      } else if (available >= needed) {
        lineResults.push({ title: item.title, needed, available, status: 'ok' });
      } else {
        // Insufficient stock — this single item blocks the entire order
        const s = available > 0 ? 'partial' : 'no_stock';
        lineResults.push({ title: item.title, needed, available, status: s });
        if (!blockedBy) blockedBy = `${item.title} (need ${needed}, have ${available})`;
      }
    }

    const ready = !blockedBy;

    // Only deduct stock when the full order can ship — partial deductions cause overselling
    if (ready) {
      for (const item of order.line_items) {
        if (item.fulfillable_quantity > 0) {
          runningStock[item.variant_id] -= item.fulfillable_quantity;
          productOrderCount[item.variant_id] = (productOrderCount[item.variant_id] || 0) + 1;
        }
      }
    }

    return {
      order_id: order.id,
      order_number: order.order_number,
      created_at: order.created_at,
      customer: order.customer
        ? `${order.customer.first_name} ${order.customer.last_name}`.trim()
        : 'Guest',
      existing_tags: (order.tags || '').split(',').map(t => t.trim()).filter(Boolean),
      ready,
      blockedBy,
      line_items: lineResults,
    };
  });
}

// ─── Sync RTFF tags ──────────────────────────────────────────────────────────
// Adds RTFF to ready orders, removes it from orders that are no longer ready.

async function syncTags(queue) {
  const tag = CONFIG.rtffTag;
  let tagged = 0, untagged = 0, skipped = 0;

  for (const order of queue) {
    const hasTag = order.existing_tags.includes(tag);

    if (order.ready && !hasTag) {
      const newTags = [...order.existing_tags, tag].join(', ');
      await shopifyPut(`/orders/${order.order_id}.json`, { order: { id: order.order_id, tags: newTags } });
      console.log(`  + Tagged   #${order.order_number} → ${tag}`);
      tagged++;
      await sleep(500);
    } else if (!order.ready && hasTag) {
      const newTags = order.existing_tags.filter(t => t !== tag).join(', ');
      await shopifyPut(`/orders/${order.order_id}.json`, { order: { id: order.order_id, tags: newTags } });
      console.log(`  - Untagged #${order.order_number} (no longer ready)`);
      untagged++;
      await sleep(500);
    } else {
      skipped++;
    }
  }

  return { tagged, untagged, skipped };
}

// ─── Print summary ───────────────────────────────────────────────────────────

function printSummary(queue) {
  const ready = queue.filter(o => o.ready);
  const blocked = queue.filter(o => !o.ready);

  console.log('\n══════════════════════════════════════════');
  console.log(`FULFILLMENT QUEUE  —  ${new Date().toLocaleString()}`);
  console.log(`Per-product limit: ${CONFIG.perProductLimit === Infinity ? 'none' : CONFIG.perProductLimit} orders`);
  console.log('══════════════════════════════════════════\n');

  console.log(`READY TO FULFILL (${ready.length}):\n`);
  for (const o of ready) {
    console.log(`  #${o.order_number}  ${o.created_at.slice(0, 10)}  ${o.customer}`);
    for (const item of o.line_items) {
      if (item.status === 'already_fulfilled') continue;
      console.log(`    ✓  ${item.title}  x${item.needed}  (stock: ${item.available})`);
    }
  }

  console.log(`\nBLOCKED (${blocked.length}):\n`);
  for (const o of blocked) {
    console.log(`  #${o.order_number}  ${o.created_at.slice(0, 10)}  ${o.customer}`);
    for (const item of o.line_items) {
      if (item.status === 'already_fulfilled') continue;
      const flag =
        item.status === 'ok'           ? `✓  stock ok (${item.available})` :
        item.status === 'no_stock'     ? '✗  NO STOCK' :
        item.status === 'partial'      ? `✗  partial stock (${item.available}/${item.needed})` :
        item.status === 'limit_reached'? '✗  per-product limit reached' : '';
      console.log(`    ${flag}  — ${item.title}  x${item.needed}`);
    }
    console.log(`    → Blocked by: ${o.blockedBy}`);
  }

  console.log('\n══════════════════════════════════════════\n');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching unfulfilled orders (oldest first)...');
  const orders = await getAllUnfulfilledOrders();
  console.log(`Found ${orders.length} unfulfilled orders`);

  const variantIds = orders.flatMap(o => o.line_items.map(i => i.variant_id));
  console.log('Fetching inventory levels...');
  const stockByVariantId = await getStockByVariantId(variantIds);

  const queue = buildQueue(orders, stockByVariantId);
  printSummary(queue);

  console.log(`Syncing ${CONFIG.rtffTag} tags in Shopify...`);
  const { tagged, untagged, skipped } = await syncTags(queue);
  console.log(`Done — tagged: ${tagged}  untagged: ${untagged}  no change: ${skipped}\n`);
}

main().catch(console.error);
