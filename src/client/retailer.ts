// Fichier généré par generate.mjs à partir de retailers/kazidomi/spec.json. Ne pas modifier ici.
export interface ScopeField { key: string; env: string; description: string; example: string; pattern?: string }
export const RETAILER: {
  id: string; slug: string; version: string; label: string; origin: string; entryUrl: string; loginUrl: string; signupUrl: string;
  platform: string; fulfillment: ReadonlyArray<"delivery" | "click_and_collect">; accountRequired: boolean;
  scopeFields: ReadonlyArray<ScopeField>;
} = {
  "id": "kazidomi",
  "slug": "kazidomi",
  "version": "0.1.0",
  "label": "Kazidomi",
  "origin": "https://www.kazidomi.com",
  "entryUrl": "https://www.kazidomi.com/fr",
  "loginUrl": "https://www.kazidomi.com/fr/login",
  "signupUrl": "https://www.kazidomi.com/fr/register",
  "platform": "nextjs-api",
  "fulfillment": [
    "delivery"
  ],
  "accountRequired": false,
  "scopeFields": []
};
