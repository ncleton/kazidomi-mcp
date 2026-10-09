import {
  ROBOT_PATTERN, decodeHtml, formatEuro, hasVeganClaim, isObject, isOrganic, parsePrice, str, stripTags,
  type Adapter, type MutationInput, type SessionSignals,
} from "./adapter.js";
import { ContractChangedError } from "./errors.js";
import type { CartInput, ProductInput, SummaryInput } from "./types.js";

const HOSTS = new Set(["www.kazidomi.com", "kazidomi.com"]);

const PRELUDE = String.raw`
const clean = (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim();
const API = "https://api.kazidomi.com/api/v2/fr";
const guest = () => { const match = document.cookie.match(/tokenUnLogged=([^;]+)/); if (!match) throw new Error("Jeton invité Kazidomi absent"); return match[1]; };
const api = async (path, method, body) => {
  const response = await fetch(API + path, { method: method || "GET", headers: { Accept: "application/json, text/plain, */*", "Content-Type": "application/json", "X-Guest-Token": guest() }, body: body ? JSON.stringify(body) : undefined });
  const json = await response.json().catch(() => null);
  if (!response.ok || !json) throw new Error("API " + path + " HTTP " + response.status);
  return json;
};
const readCart = async () => {
  const json = await api("/cart", "GET");
  const cart = json && json.cart;
  if (!cart || !Array.isArray(cart.productSales)) throw new Error("Contrat panier Kazidomi absent");
  return {
    total: cart.total_include_sales_product_standard,
    items: cart.productSales.filter((sale) => !sale.temporary_deleted && sale.product).map((sale) => {
      const prices = sale.product.prices && sale.product.prices.prices;
      const price = prices && (prices.promo_or_standard || prices.standard);
      return { legacy_id: sale.product.legacyId, name: sale.product.title, quantity: sale.quantity, unit_price: price ? price.priceInclude : null };
    }),
  };
};
`;

function searchExpression(query: string, limit: number): string {
  return String.raw`(async () => {
    ${PRELUDE}
    const json = await api("/search", "POST", { query: ${JSON.stringify(query)}, currentPage: 1, indexes: ["KAZIDOMI2_ai_products_fr"], maxResults: ${limit}, seeLastOrders: false });
    const hits = json && json.products && json.products.hits;
    if (!Array.isArray(hits)) throw new Error("Contrat recherche Kazidomi absent");
    return hits.map((hit) => ({
      legacy_id: hit.legacyId, name: hit.bo_name || hit.name, brand: hit.brand && hit.brand.name || null, url: hit.URL,
      price: hit.standardPrice, per_kg: hit.standardPricePerKg, per_l: hit.standardPricePerL,
      stock: hit.available_stock, infinite: hit.is_infinite_stock === true, active: hit.active, visible: hit.visible, badge: hit.badge, bio: hit.is_bio === true, ean: hit.eanPrimary || null,
    }));
  })()`;
}

function productExpression(productUrl: string): string {
  return String.raw`(async () => {
    ${PRELUDE}
    const target = new URL(${JSON.stringify(productUrl)});
    const page = await fetch(target.pathname, { credentials: "include" });
    if (!page.ok) throw new Error("Fiche HTTP " + page.status);
    const doc = new DOMParser().parseFromString(await page.text(), "text/html");
    let product = null;
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const json = JSON.parse(script.textContent);
        const found = (json["@graph"] || [json]).find((entry) => entry && entry["@type"] === "Product");
        if (found) { product = found; break; }
      } catch (error) { /* bloc JSON-LD non exploitable */ }
    }
    if (!product) throw new Error("Contrat JSON-LD Product absent");
    const detail = product.productId ? await api("/products/" + product.productId, "GET") : null;
    const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
    const prices = detail && detail.prices && detail.prices.prices;
    const standard = prices && (prices.promo_or_standard || prices.standard);
    const ingredients = doc.querySelector("#listeDesIngredients");
    const badges = detail ? [].concat(detail.nutritional || [], detail.brandBadge || [], detail.badges || []).map((badge) => clean(badge.title || badge.name || badge)) : [];
    return {
      legacy_id: product.sku, name: product.name, brand: product.brand && (product.brand.name || product.brand) || null,
      ean: product.gtin13 || product.gtin || (detail && detail.ean) || null,
      price: offer && offer.price != null ? offer.price : (standard ? standard.priceInclude : null),
      availability: offer && offer.availability || null,
      per_kg: standard ? standard.weightPrice : null, per_l: standard ? standard.volumePrice : null,
      description: product.description || "",
      ingredients: ingredients ? clean(ingredients.textContent).replace(/^liste des ingr[ée]dients\s*/i, "") : null,
      badges: badges,
    };
  })()`;
}

function cartExpression(): string {
  return String.raw`(async () => { ${PRELUDE} return readCart(); })()`;
}

function mutationExpression(input: MutationInput): string {
  return String.raw`(async () => {
    ${PRELUDE}
    const legacyId = Number(${JSON.stringify(input.productId)});
    const target = ${input.targetQuantity};
    const before = await readCart();
    const line = before.items.find((item) => Number(item.legacy_id) === legacyId);
    const current = line ? Number(line.quantity) : 0;
    if (current === target) return { before, after: before, applied: false };
    await api("/cart/set-quantity-products", "POST", [{ productLegacyId: legacyId, quantity: target }]);
    return { before, after: await readCart(), applied: true };
  })()`;
}

function perUnit(kg: unknown, litre: unknown): string | null {
  const weight = parsePrice(kg);
  const volume = parsePrice(litre);
  if (weight && weight > 0) return `${formatEuro(weight)}/kg`;
  if (volume && volume > 0) return `${formatEuro(volume)}/L`;
  return null;
}

export const adapter: Adapter = {
  entryUrl: () => "https://www.kazidomi.com/fr",
  matchesTab: (u) => u.protocol === "https:" && HOSTS.has(u.hostname),
  inspectSession({ snapshot, tabUrl }): SessionSignals {
    let onSite = false;
    try { onSite = HOSTS.has(new URL(tabUrl).hostname); } catch { onSite = false; }
    const robotVisible = ROBOT_PATTERN.test(snapshot);
    return { ready: onSite && !robotVisible && snapshot.trim().length > 0, robotVisible, accountConnected: /d[ée]connexion|se d[ée]connecter/i.test(snapshot) };
  },
  validateProductUrl(u) {
    if (u.protocol !== "https:" || !HOSTS.has(u.hostname) || !u.pathname.startsWith("/fr/catalogue/produits/")) throw new Error("Hors des fiches produit Kazidomi.");
  },
  searchExpression: (_config, query, limit) => searchExpression(query, limit),
  normalizeSearch(raw): SummaryInput[] {
    if (!Array.isArray(raw)) throw new ContractChangedError("La recherche n’a pas retourné une liste de produits.");
    return raw.map((entry): SummaryInput => {
      if (!isObject(entry)) throw new ContractChangedError("Un produit n’est plus un objet exploitable.");
      const id = str(entry, "legacy_id");
      const name = str(entry, "name");
      const price = parsePrice(entry.price);
      const url = str(entry, "url");
      const stock = typeof entry.stock === "number" && Number.isInteger(entry.stock) ? Math.max(0, entry.stock) : null;
      if (!id || !name || price === null || !url || stock === null || typeof entry.active !== "boolean") throw new ContractChangedError("Un produit ne contient plus son identifiant, son nom, son prix, son adresse, son stock ou son état.");
      const orderable = entry.active === true && entry.visible !== false && (stock > 0 || entry.infinite === true) && entry.badge !== "not-available";
      return {
        product_id: id, name: decodeHtml(name), brand: str(entry, "brand"), price, unit_price: perUnit(entry.per_kg, entry.per_l),
        availability: orderable ? "available" : "out_of_stock", available_quantity: entry.infinite === true ? null : stock, organic: entry.bio === true || isOrganic(name), product_url: url,
      };
    });
  },
  productExpression: (_config, productUrl) => productExpression(productUrl),
  normalizeProduct(raw, _config, requestedUrl): ProductInput {
    if (!isObject(raw)) throw new ContractChangedError("La fiche n’a pas retourné l’objet produit attendu.");
    const id = str(raw, "legacy_id");
    const name = str(raw, "name");
    const price = parsePrice(raw.price);
    const offer = typeof raw.availability === "string" ? raw.availability : "";
    if (!id || !name || price === null || !/InStock|OutOfStock|SoldOut|Discontinued|LimitedAvailability/i.test(offer)) throw new ContractChangedError("La fiche ne contient plus son identifiant, son nom, son prix ou sa disponibilité.");
    const badges = Array.isArray(raw.badges) ? raw.badges.map(String) : [];
    const description = stripTags(str(raw, "description") ?? "");
    return {
      product_id: id, name: decodeHtml(name), brand: str(raw, "brand"), price, unit_price: perUnit(raw.per_kg, raw.per_l),
      availability: /InStock|LimitedAvailability/i.test(offer) ? "available" : "out_of_stock", available_quantity: null,
      organic: badges.some((badge) => /biologique|bio/i.test(badge)) || isOrganic(name), product_url: requestedUrl,
      ean: str(raw, "ean"), ingredients: str(raw, "ingredients"), vegan_claim: badges.some((badge) => /vegan|végan|végétal/i.test(badge)) || hasVeganClaim(`${name} ${description}`), nutrition: [],
    };
  },
  cartExpression: () => cartExpression(),
  normalizeCart(raw): CartInput {
    if (!isObject(raw) || !Array.isArray(raw.items)) throw new ContractChangedError("Le panier n’a plus la forme observée.");
    const items = raw.items.map((entry) => {
      if (!isObject(entry)) throw new ContractChangedError("Une ligne de panier n’est plus exploitable.");
      const id = str(entry, "legacy_id");
      const quantity = Number(entry.quantity);
      if (!id || !Number.isInteger(quantity) || quantity < 0) throw new ContractChangedError("Une ligne de panier ne contient plus son identifiant ou sa quantité.");
      const unit = parsePrice(entry.unit_price);
      return { product_id: id, name: str(entry, "name"), quantity, available_quantity: null, unit_price: unit, line_total: unit === null ? null : Math.round(unit * quantity * 100) / 100 };
    });
    const total = parsePrice(raw.total);
    const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
    return { empty: totalQuantity === 0, total_quantity: totalQuantity, total_price: formatEuro(total ?? 0), items };
  },
  mutationExpression: (_config, input) => mutationExpression(input),
};
