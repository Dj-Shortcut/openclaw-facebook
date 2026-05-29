export type Style =
  | "caricature"
  | "storybook-anime"
  | "afroman-americana"
  | "gold"
  | "petals"
  | "clouds"
  | "cinematic"
  | "disco"
  | "cyberpunk"
  | "oil-paint"
  | "norman-blackwell";

type StyleId =
  | "STYLE_CARICATURE"
  | "STYLE_STORYBOOK_ANIME"
  | "STYLE_AFROMAN_AMERICANA"
  | "STYLE_PETALS"
  | "STYLE_GOLD"
  | "STYLE_CINEMATIC"
  | "STYLE_OIL_PAINT"
  | "STYLE_DISCO"
  | "STYLE_CLOUDS"
  | "STYLE_CYBERPUNK"
  | "STYLE_NORMAN_BLACKWELL";

export type StyleCategory =
  | "illustrated"
  | "atmosphere"
  | "bold";

type StyleCategoryId =
  | "STYLE_CATEGORY_ILLUSTRATED"
  | "STYLE_CATEGORY_ATMOSPHERE"
  | "STYLE_CATEGORY_BOLD";

type StyleConfig = {
  id: StyleId;
  payload: StyleId;
  style: Style;
  label: string;
  category: StyleCategory;
  thumbnailPrompt?: string;
};

type StyleCategoryConfig = {
  id: StyleCategoryId;
  payload: StyleCategoryId;
  category: StyleCategory;
  label: string;
};

const STYLE_CONFIGS: StyleConfig[] = [
  {
    id: "STYLE_CARICATURE",
    payload: "STYLE_CARICATURE",
    style: "caricature",
    label: "🎨 Caricature",
    category: "illustrated",
  },
  {
    id: "STYLE_STORYBOOK_ANIME",
    payload: "STYLE_STORYBOOK_ANIME",
    style: "storybook-anime",
    label: "🌿 Storybook Anime",
    category: "illustrated",
  },
  {
    id: "STYLE_AFROMAN_AMERICANA",
    payload: "STYLE_AFROMAN_AMERICANA",
    style: "afroman-americana",
    label: "Afroman",
    category: "bold",
    thumbnailPrompt:
      "Afroman wearing an American flag suit, centered portrait, strong silhouette, high contrast red white and blue, clean background, bold lighting, expressive confident face, simplified composition, optimized for small mobile preview",
  },
  {
    id: "STYLE_PETALS",
    payload: "STYLE_PETALS",
    style: "petals",
    label: "🌸 Petals",
    category: "atmosphere",
  },
  {
    id: "STYLE_GOLD",
    payload: "STYLE_GOLD",
    style: "gold",
    label: "✨ Gold",
    category: "bold",
  },
  {
    id: "STYLE_CINEMATIC",
    payload: "STYLE_CINEMATIC",
    style: "cinematic",
    label: "🎬 Cinematic",
    category: "atmosphere",
  },
  {
    id: "STYLE_OIL_PAINT",
    payload: "STYLE_OIL_PAINT",
    style: "oil-paint",
    label: "🖼️ Oil Paint",
    category: "illustrated",
  },
  {
    id: "STYLE_CYBERPUNK",
    payload: "STYLE_CYBERPUNK",
    style: "cyberpunk",
    label: "🌃 Cyberpunk",
    category: "bold",
  },
  {
    id: "STYLE_NORMAN_BLACKWELL",
    payload: "STYLE_NORMAN_BLACKWELL",
    style: "norman-blackwell",
    label: "📰 Norman Blackwell",
    category: "illustrated",
  },
  {
    id: "STYLE_DISCO",
    payload: "STYLE_DISCO",
    style: "disco",
    label: "🪩 Disco Glow",
    category: "bold",
  },
  {
    id: "STYLE_CLOUDS",
    payload: "STYLE_CLOUDS",
    style: "clouds",
    label: "☁️ Clouds",
    category: "atmosphere",
  },
];

const STYLE_IDS = new Set<StyleId>(STYLE_CONFIGS.map(style => style.id));

export const STYLE_CATEGORY_CONFIGS: StyleCategoryConfig[] = [
  {
    id: "STYLE_CATEGORY_ILLUSTRATED",
    payload: "STYLE_CATEGORY_ILLUSTRATED",
    category: "illustrated",
    label: "🎨 Illustrated",
  },
  {
    id: "STYLE_CATEGORY_ATMOSPHERE",
    payload: "STYLE_CATEGORY_ATMOSPHERE",
    category: "atmosphere",
    label: "🌤️ Atmosphere",
  },
  {
    id: "STYLE_CATEGORY_BOLD",
    payload: "STYLE_CATEGORY_BOLD",
    category: "bold",
    label: "⚡ Bold",
  },
];

const STYLE_CATEGORY_IDS = new Set<StyleCategoryId>(
  STYLE_CATEGORY_CONFIGS.map(category => category.id)
);

function isStylePayload(value: string): value is StyleId {
  return STYLE_IDS.has(value as StyleId);
}

function isStyleCategoryPayload(value: string): value is StyleCategoryId {
  return STYLE_CATEGORY_IDS.has(value as StyleCategoryId);
}

function getStyleById(styleId: StyleId): StyleConfig {
  const style = STYLE_CONFIGS.find(item => item.id === styleId);

  if (!style) {
    throw new Error(`Unknown style: ${styleId}`);
  }

  return style;
}

function getStyleCategoryById(
  styleCategoryId: StyleCategoryId
): StyleCategoryConfig {
  const category = STYLE_CATEGORY_CONFIGS.find(item => item.id === styleCategoryId);

  if (!category) {
    throw new Error(`Unknown style category: ${styleCategoryId}`);
  }

  return category;
}

export function getStylesForCategory(category: StyleCategory): StyleConfig[] {
  return STYLE_CONFIGS.filter(style => style.category === category);
}
