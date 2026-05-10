import {
  and,
  crmActivities,
  crmClients,
  eq,
  genId,
  getDb,
  getPool,
  now,
  crmTelesales,
} from "./shared";

export async function upsertCrmProduct(userId: string, data: {
  reference?: string;
  name: string;
  category?: string;
  unit?: string;
  conditioning?: string;
  priceHt: number;
  tvaRate?: number;
}) {
  const pool = getPool();
  const id = genId("prd");
  const result = await pool.query(`
    INSERT INTO crm_products (id, user_id, reference, name, category, unit, conditioning, price_ht, tva_rate, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
    ON CONFLICT ON CONSTRAINT crm_products_pkey DO UPDATE SET
      name = EXCLUDED.name, category = EXCLUDED.category, unit = EXCLUDED.unit,
      conditioning = EXCLUDED.conditioning, price_ht = EXCLUDED.price_ht,
      tva_rate = EXCLUDED.tva_rate, updated_at = EXCLUDED.updated_at
    RETURNING id
  `, [id, userId, data.reference, data.name, data.category, data.unit || "pièce", data.conditioning, data.priceHt, data.tvaRate || 20, now()]);
  return { id: result.rows[0]?.id || id };
}

export async function listCrmProducts(userId: string, opts?: { category?: string; active?: boolean }) {
  const pool = getPool();
  let query = `SELECT * FROM crm_products WHERE user_id = $1`;
  const vals: unknown[] = [userId];
  if (opts?.category) { query += ` AND category = $${vals.length + 1}`; vals.push(opts.category); }
  if (opts?.active !== undefined) { query += ` AND active = $${vals.length + 1}`; vals.push(opts.active); }
  query += ` ORDER BY category, name`;
  return (await pool.query(query, vals)).rows;
}

export async function upsertCrmClient(userId: string, data: {
  id?: string;
  code?: string;
  name: string;
  company?: string;
  address?: string;
  phone?: string;
  email?: string;
  deliveryDay?: string;
  conditions?: Record<string, unknown>;
  notes?: string;
  score?: string;
}) {
  const id = data.id || genId("cli");
  const pool = getPool();
  await pool.query(`
    INSERT INTO crm_clients (id, user_id, code, name, company, address, phone, email, delivery_day, conditions, notes, score, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
    ON CONFLICT ON CONSTRAINT crm_clients_pkey DO UPDATE SET
      code = COALESCE(EXCLUDED.code, crm_clients.code),
      name = EXCLUDED.name, company = EXCLUDED.company, address = EXCLUDED.address,
      phone = EXCLUDED.phone, email = EXCLUDED.email, delivery_day = EXCLUDED.delivery_day,
      conditions = EXCLUDED.conditions, notes = EXCLUDED.notes, score = EXCLUDED.score, updated_at = EXCLUDED.updated_at
  `, [id, userId, data.code, data.name, data.company, data.address, data.phone, data.email, data.deliveryDay, JSON.stringify(data.conditions || {}), data.notes, data.score || null, now()]);
  return { id };
}

export async function getCrmClient(userId: string, clientId: string) {
  const [row] = await getDb().select().from(crmClients).where(and(eq(crmClients.userId, userId), eq(crmClients.id, clientId))).limit(1);
  return row ?? null;
}

export async function searchCrmClients(userId: string, query: string) {
  const result = await getPool().query(`
    SELECT * FROM crm_clients WHERE user_id = $1
    AND (name ILIKE $2 OR company ILIKE $2 OR code ILIKE $2 OR phone ILIKE $2)
    AND active = true ORDER BY name LIMIT 20
  `, [userId, `%${query}%`]);
  return result.rows;
}

export async function listCrmClients(userId: string, opts?: { deliveryDay?: string; score?: string }) {
  const pool = getPool();
  let q = `SELECT * FROM crm_clients WHERE user_id = $1 AND active = true`;
  const vals: unknown[] = [userId];
  if (opts?.deliveryDay) { q += ` AND delivery_day = $${vals.length + 1}`; vals.push(opts.deliveryDay); }
  if (opts?.score) { q += ` AND score = $${vals.length + 1}`; vals.push(opts.score); }
  q += ` ORDER BY name`;
  return (await pool.query(q, vals)).rows;
}

export async function createCrmOrder(userId: string, data: {
  clientId: string;
  orderDate: string;
  channel?: string;
  status?: string;
  notes?: string;
  sessionId?: string;
  lines: Array<{ productId: string; quantity: number; unitPriceHt: number }>;
}) {
  const pool = getPool();
  const orderId = genId("cmd");
  const totalHt = data.lines.reduce((sum, line) => sum + line.quantity * line.unitPriceHt, 0);
  await pool.query(`
    INSERT INTO crm_orders (id, user_id, client_id, session_id, order_date, channel, status, total_ht, notes, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `, [orderId, userId, data.clientId, data.sessionId, data.orderDate, data.channel, data.status || "confirmed", totalHt, data.notes, now()]);

  for (const line of data.lines) {
    const lineId = genId("ol");
    const lineTotalHt = line.quantity * line.unitPriceHt;
    await pool.query(`
      INSERT INTO crm_order_lines (id, order_id, product_id, quantity, unit_price_ht, line_total_ht)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [lineId, orderId, line.productId, line.quantity, line.unitPriceHt, lineTotalHt]);
  }

  return { id: orderId, totalHt };
}

export async function getCrmOrdersForClient(userId: string, clientId: string, limit = 20) {
  const result = await getPool().query(`
    SELECT o.*, json_agg(json_build_object(
      'product_id', ol.product_id, 'quantity', ol.quantity,
      'unit_price_ht', ol.unit_price_ht, 'line_total_ht', ol.line_total_ht
    )) as lines
    FROM crm_orders o
    LEFT JOIN crm_order_lines ol ON ol.order_id = o.id
    WHERE o.user_id = $1 AND o.client_id = $2
    GROUP BY o.id ORDER BY o.order_date DESC LIMIT $3
  `, [userId, clientId, limit]);
  return result.rows;
}

export async function setCrmRounds(userId: string, day: string, clientIds: string[]) {
  const pool = getPool();
  await pool.query(`DELETE FROM crm_rounds WHERE user_id = $1 AND day = $2`, [userId, day]);
  for (let i = 0; i < clientIds.length; i++) {
    const id = genId("rnd");
    await pool.query(`
      INSERT INTO crm_rounds (id, user_id, day, client_id, order_index, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [id, userId, day, clientIds[i], i, now()]);
  }
}

export async function getCrmRounds(userId: string, day: string) {
  const result = await getPool().query(`
    SELECT r.*, c.name as client_name, c.company, c.phone, c.address
    FROM crm_rounds r
    JOIN crm_clients c ON c.id = r.client_id
    WHERE r.user_id = $1 AND r.day = $2
    ORDER BY r.order_index
  `, [userId, day]);
  return result.rows;
}

export async function logTelesale(userId: string, data: {
  sessionId?: string;
  clientId: string;
  contactDate: string;
  channel: string;
  status: string;
  orderId?: string;
  nextFollowup?: string;
  notes?: string;
}) {
  const id = genId("tel");
  await getDb().insert(crmTelesales).values({
    id,
    userId,
    sessionId: data.sessionId || null,
    clientId: data.clientId,
    contactDate: data.contactDate,
    channel: data.channel,
    status: data.status as any,
    orderId: data.orderId || null,
    nextFollowup: data.nextFollowup || null,
    notes: data.notes || null,
    createdAt: now(),
  });
  return { id };
}

export async function getPendingFollowups(userId: string) {
  const result = await getPool().query(`
    SELECT t.*, c.name as client_name, c.company, c.phone
    FROM crm_telesales t
    JOIN crm_clients c ON c.id = t.client_id
    WHERE t.user_id = $1 AND t.status IN ('pas_de_réponse', 'relance')
    AND (t.next_followup IS NULL OR t.next_followup <= $2)
    ORDER BY t.next_followup ASC NULLS FIRST
  `, [userId, now()]);
  return result.rows;
}

export async function logCrmActivity(userId: string, data: {
  clientId: string;
  sessionId?: string;
  type: string;
  summary: string;
  followUp?: string;
}) {
  const id = genId("act");
  await getDb().insert(crmActivities).values({
    id,
    userId,
    clientId: data.clientId,
    sessionId: data.sessionId || null,
    type: data.type,
    summary: data.summary,
    followUp: data.followUp || null,
    createdAt: now(),
  });
  return { id };
}

export async function getCrmClientStats(userId: string, clientId?: string) {
  const query = `
    SELECT
      c.id, c.name, c.company, c.score,
      COALESCE(SUM(o.total_ht) FILTER (WHERE o.order_date::timestamp > NOW() - INTERVAL '12 months'), 0) as ca_12m,
      COALESCE(SUM(o.total_ht) FILTER (WHERE o.order_date::timestamp > NOW() - INTERVAL '1 month'), 0) as ca_mois,
      COUNT(DISTINCT o.id) as nb_commandes,
      COALESCE(AVG(o.total_ht), 0) as panier_moyen,
      MAX(o.order_date) as derniere_commande,
      EXTRACT(DAY FROM NOW() - MAX(o.order_date)::timestamp) as jours_inactif
    FROM crm_clients c
    LEFT JOIN crm_orders o ON o.client_id = c.id AND o.user_id = c.user_id AND o.status != 'cancelled'
    WHERE c.user_id = $1 AND c.active = true
    ${clientId ? "AND c.id = $2" : ""}
    GROUP BY c.id ORDER BY ca_12m DESC
  `;
  const result = await getPool().query(query, clientId ? [userId, clientId] : [userId]);
  return clientId ? result.rows[0] ?? null : result.rows;
}

export async function getCrmCadencier(userId: string, clientId?: string) {
  const query = `
    WITH order_intervals AS (
      SELECT
        o.client_id, ol.product_id, p.name as product_name,
        ol.quantity, o.order_date,
        LAG(o.order_date) OVER (PARTITION BY o.client_id, ol.product_id ORDER BY o.order_date) as prev_date
      FROM crm_orders o
      JOIN crm_order_lines ol ON ol.order_id = o.id
      JOIN crm_products p ON p.id = ol.product_id
      WHERE o.user_id = $1 AND o.status != 'cancelled'
      ${clientId ? "AND o.client_id = $2" : ""}
    )
    SELECT
      client_id, product_id, product_name,
      ROUND(AVG(quantity)::numeric, 1) as qte_habituelle,
      ROUND(AVG(EXTRACT(DAY FROM order_date::timestamp - prev_date::timestamp))::numeric, 0) as frequence_jours,
      MAX(order_date) as derniere_commande,
      COUNT(*) as nb_commandes
    FROM order_intervals
    WHERE prev_date IS NOT NULL
    GROUP BY client_id, product_id, product_name
    HAVING COUNT(*) >= 2
    ORDER BY client_id, nb_commandes DESC
  `;
  return (await getPool().query(query, clientId ? [userId, clientId] : [userId])).rows;
}

export async function getCrmDashboard(userId: string) {
  const result = await getPool().query(`
    SELECT
      (SELECT COUNT(*) FROM crm_clients WHERE user_id = $1 AND active = true) as total_clients,
      (SELECT COUNT(*) FROM crm_products WHERE user_id = $1 AND active = true) as total_products,
      (SELECT COALESCE(SUM(total_ht), 0) FROM crm_orders WHERE user_id = $1 AND status != 'cancelled'
        AND order_date::timestamp > NOW() - INTERVAL '30 days') as ca_30j,
      (SELECT COUNT(*) FROM crm_orders WHERE user_id = $1 AND status != 'cancelled'
        AND order_date::timestamp > NOW() - INTERVAL '30 days') as commandes_30j,
      (SELECT COUNT(*) FROM crm_telesales WHERE user_id = $1
        AND status IN ('pas_de_réponse', 'relance')) as relances_pending,
      (SELECT COUNT(*) FROM crm_clients WHERE user_id = $1 AND score = 'red' AND active = true) as clients_at_risk
  `, [userId]);
  return result.rows[0];
}
