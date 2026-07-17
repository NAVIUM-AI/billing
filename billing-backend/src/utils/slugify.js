/**
 * Turns a business name into a URL-safe slug, e.g. for tenant subdomains
 * or shareable links: "Acme Travels & Co." -> "acme-travels-co"
 */

const MAX_LENGTH = 80;

/**
 * @param {string} name
 * @returns {string}
 */
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // non-alphanumeric runs -> single dash
    .replace(/-+/g, "-") // collapse consecutive dashes
    .replace(/^-|-$/g, "") // trim leading/trailing dashes
    .slice(0, MAX_LENGTH)
    .replace(/-$/, ""); // truncation may leave a trailing dash — drop it
}

module.exports = { slugify };
