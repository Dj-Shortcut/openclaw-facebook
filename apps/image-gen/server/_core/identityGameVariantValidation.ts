import net from "node:net";

import {
  GAME_VARIANTS,
  V1_ARCHETYPE_IDS,
  variantSchema,
  type GameVariantDefinition,
} from "./identityGameVariants";

export type VariantValidationContext = {
  variant: GameVariantDefinition;
  normalizedId: string;
  mapKeys: string[];
  mapKeySet: Set<string>;
  expectedTriples: Set<string>;
  archetypeIds: Set<(typeof V1_ARCHETYPE_IDS)[number]>;
  missingArchetypes: (typeof V1_ARCHETYPE_IDS)[number][];
};

function normalizeVariantId(value: string): string {
  return value.trim().toLowerCase();
}

function isPrivateOrReservedIpLiteral(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  const v4MappedMatch = normalizedHostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4MappedMatch) {
    return isPrivateOrReservedIpLiteral(v4MappedMatch[1]);
  }

  const mappedHexMatch = normalizedHostname.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHexMatch) {
    const high = Number.parseInt(mappedHexMatch[1], 16);
    const low = Number.parseInt(mappedHexMatch[2], 16);
    const ipv4 = [
      (high >> 8) & 0xff,
      high & 0xff,
      (low >> 8) & 0xff,
      low & 0xff,
    ].join(".");
    return isPrivateOrReservedIpLiteral(ipv4);
  }

  const ipVersion = net.isIP(normalizedHostname);
  if (ipVersion === 4) {
    const [a, b] = normalizedHostname.split(".").map(part => Number(part));
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  if (ipVersion === 6) {
    return (
      normalizedHostname === "::1" ||
      normalizedHostname.startsWith("fc") ||
      normalizedHostname.startsWith("fd") ||
      normalizedHostname.startsWith("fe8") ||
      normalizedHostname.startsWith("fe9") ||
      normalizedHostname.startsWith("fea") ||
      normalizedHostname.startsWith("feb")
    );
  }

  return false;
}

function isLikelyPublicImageUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:") {
    return false;
  }

  if (!parsed.hostname || parsed.hostname === "localhost") {
    return false;
  }

  if (isPrivateOrReservedIpLiteral(parsed.hostname)) {
    return false;
  }

  if (parsed.searchParams.size === 0) {
    return true;
  }

  const blockedParamHints = ["signature", "sig", "token", "expires", "x-amz-"];
  for (const key of parsed.searchParams.keys()) {
    const lower = key.toLowerCase();
    if (blockedParamHints.some(hint => lower.includes(hint))) {
      return false;
    }
  }

  return true;
}

export function validateVariantShape(
  rawVariant: GameVariantDefinition,
  errors: string[]
): GameVariantDefinition | null {
  const parsed = variantSchema.safeParse(rawVariant);
  if (!parsed.success) {
    errors.push(
      `Invalid variant definition: ${parsed.error.issues
        .map(issue => issue.path.join("."))
        .join(", ")}`
    );
    return null;
  }

  return parsed.data;
}

function enumerateQuestionTriples(
  questions: GameVariantDefinition["questions"]
): Array<{
  key: string;
  option1: GameVariantDefinition["questions"][0]["options"][number];
  option2: GameVariantDefinition["questions"][1]["options"][number];
  option3: GameVariantDefinition["questions"][2]["options"][number];
}> {
  const triples = [];
  for (const option1 of questions[0].options) {
    for (const option2 of questions[1].options) {
      for (const option3 of questions[2].options) {
        triples.push({
          key: `${option1.id}|${option2.id}|${option3.id}`,
          option1,
          option2,
          option3,
        });
      }
    }
  }
  return triples;
}

function buildExpectedTriples(variant: GameVariantDefinition): Set<string> {
  const expectedTriples = new Set<string>();
  for (const triple of enumerateQuestionTriples(variant.questions)) {
    expectedTriples.add(triple.key);
  }
  return expectedTriples;
}

function buildVariantValidationContext(
  variant: GameVariantDefinition
): VariantValidationContext {
  const mapKeys = Object.keys(variant.resolutionMap);
  const archetypeIds = new Set(variant.archetypes.map(archetype => archetype.id));

  return {
    variant,
    normalizedId: normalizeVariantId(variant.variantId),
    mapKeys,
    mapKeySet: new Set(mapKeys),
    expectedTriples: buildExpectedTriples(variant),
    archetypeIds,
    missingArchetypes: V1_ARCHETYPE_IDS.filter(id => !archetypeIds.has(id)),
  };
}

export function validateVariantIdentity(
  context: VariantValidationContext,
  seenIds: Set<string>,
  errors: string[]
): void {
  if (seenIds.has(context.normalizedId)) {
    errors.push(`Duplicate variantId: ${context.variant.variantId}`);
  }
  seenIds.add(context.normalizedId);
}

export function validateVariantShareMeta(
  context: VariantValidationContext,
  errors: string[]
): void {
  const { variant } = context;
  if (variant.status !== "active") {
    return;
  }

  if (!variant.share) {
    errors.push(`Active variant ${variant.variantId} must define share metadata`);
    return;
  }

  if (!isLikelyPublicImageUrl(variant.share.imageUrl)) {
    errors.push(
      `Active variant ${variant.variantId} has non-public or non-cache-safe share.imageUrl`
    );
  }
}

export function validateVariantQuestionOptions(
  context: VariantValidationContext,
  errors: string[]
): void {
  for (const question of context.variant.questions) {
    const seenOptionIds = new Set<string>();
    for (const option of question.options) {
      if (seenOptionIds.has(option.id)) {
        errors.push(
          `Variant ${context.variant.variantId} question ${question.id} has duplicate option id: ${option.id}`
        );
      }
      seenOptionIds.add(option.id);
    }
  }
}

export function validateVariantArchetypes(
  context: VariantValidationContext,
  errors: string[]
): void {
  if (context.missingArchetypes.length > 0) {
    errors.push(
      `Variant ${context.variant.variantId} is missing archetypes: ${context.missingArchetypes.join(", ")}`
    );
  }

  if (context.archetypeIds.size < context.variant.archetypes.length) {
    errors.push(`Variant ${context.variant.variantId} has duplicate archetype ids`);
  }
}

export function validateVariantResolutionMap(
  context: VariantValidationContext,
  errors: string[]
): void {
  for (const tripleKey of context.expectedTriples) {
    if (!context.mapKeySet.has(tripleKey)) {
      errors.push(
        `Variant ${context.variant.variantId} is missing resolutionMap key: ${tripleKey}`
      );
    }
  }

  for (const tripleKey of context.mapKeys) {
    if (!context.expectedTriples.has(tripleKey)) {
      errors.push(
        `Variant ${context.variant.variantId} has unknown resolutionMap key: ${tripleKey}`
      );
    }

    const mappedArchetypeId = context.variant.resolutionMap[tripleKey];
    if (!context.archetypeIds.has(mappedArchetypeId)) {
      errors.push(
        `Variant ${context.variant.variantId} maps ${tripleKey} to unknown archetype: ${mappedArchetypeId}`
      );
    }
  }
}

export function assertIdentityGameVariantCatalog(
  variants: readonly GameVariantDefinition[] = GAME_VARIANTS
): void {
  const errors: string[] = [];
  const seenIds = new Set<string>();

  for (const rawVariant of variants) {
    const variant = validateVariantShape(rawVariant, errors);
    if (!variant) {
      continue;
    }

    const context = buildVariantValidationContext(variant);
    validateVariantIdentity(context, seenIds, errors);
    validateVariantShareMeta(context, errors);
    validateVariantQuestionOptions(context, errors);
    validateVariantArchetypes(context, errors);
    validateVariantResolutionMap(context, errors);
  }

  if (errors.length > 0) {
    throw new Error(`Identity game variant catalog validation failed: ${errors.join("; ")}`);
  }
}
