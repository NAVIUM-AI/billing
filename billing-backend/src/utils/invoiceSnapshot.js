/**
 * Snapshot builders for invoice/credit-note issue (Task 4.3). Freeze
 * tenant + customer state at the moment of issue so a later edit to
 * either record never retroactively changes an already-issued
 * document — the snapshot JSONB is written exactly once (see
 * invoice.repository.js#transitionStatus's COALESCE, which never
 * overwrites a non-null snapshot).
 *
 * ─── Flagged spec deviation ───
 * The Task 4.3 spec's own field lists for both snapshots
 * (address_line1/address_line2/city/state/pincode/phone/email/website
 * on the tenant; the same set on the customer) don't match this
 * schema:
 *   - tenants has no address/phone/email/website columns at all — only
 *     name/gstin/pan/state_code/logo_url/bank_details/gst_rate exist
 *     (confirmed via \d tenants). Those never-added columns are
 *     omitted here rather than fabricated as always-null fields.
 *   - customers has no flat address_line1/city/state/pincode columns
 *     either — it has a single `address` JSONB blob shaped
 *     { line1, line2, city, district, state, pincode, country }
 *     (customer.validator.js#addressSchema). buildCustomerSnapshot
 *     keeps the FLAT shape the spec asked for (sensible for a future
 *     PDF template) but sources the values from the real nested
 *     column instead of nonexistent flat ones.
 */

/**
 * @param {object} tenant - tenants row
 * @returns {object}
 */
function buildTenantSnapshot(tenant) {
  return {
    id: tenant.id,
    name: tenant.name,
    gstin: tenant.gstin || null,
    pan: tenant.pan || null,
    state_code: tenant.state_code || null,
    logo_url: tenant.logo_url || null,
    bank_details: tenant.bank_details || null,
    gst_rate: tenant.gst_rate,
    snapshotted_at: new Date().toISOString(),
  };
}

/**
 * @param {object} customer - customers row
 * @returns {object}
 */
function buildCustomerSnapshot(customer) {
  const addr = customer.address || {};
  return {
    id: customer.id,
    customer_type: customer.customer_type,
    name: customer.name || null,
    company_name: customer.company_name || null,
    gstin: customer.gstin || null,
    pan: customer.pan || null,
    state_code: customer.state_code || null,
    address_line1: addr.line1 || null,
    address_line2: addr.line2 || null,
    city: addr.city || null,
    state: addr.state || null,
    pincode: addr.pincode || null,
    phone: customer.phone_display || customer.phone || null,
    email: customer.email || null,
    credit_days: customer.credit_days,
    snapshotted_at: new Date().toISOString(),
  };
}

module.exports = { buildTenantSnapshot, buildCustomerSnapshot };
