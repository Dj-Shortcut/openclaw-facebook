export const productionMigrationTags = Object.freeze([
  "0000_romantic_the_call",
  "0001_big_the_phantom",
  "0002_fix_daily_quota_unique",
  "0003_fresh_the_anarchist",
  "0004_customer_portal",
  "0005_workspace_tenant_model",
  "0006_workspace_privacy_requests",
  "0007_workspace_upgrade_requests",
  "0008_portal_handoff_tokens",
  "0009_mollie_billing",
  "0010_slimy_bloodstorm",
  "0011_conversation_identity_foundation",
  "0012_channel_provider_ownership",
  "0013_purple_greymalkin",
  "0014_portal_handoff_delivery_idempotency",
  "0015_production_readiness_registry",
  "0016_static_epoch_scope_fks",
  "0017_credit_wallet_expand",
]);

const base0014Tag = "0014_portal_handoff_delivery_idempotency";
const base0015Tag = "0015_production_readiness_registry";
const expand0016Tag = "0016_static_epoch_scope_fks";
const creditWallet0017Tag = "0017_credit_wallet_expand";

export function resolveProductionMigrationPlan(migrations) {
  if (!Array.isArray(migrations)) {
    throw new Error("production migration plan is unsupported");
  }
  if (migrations.length < productionMigrationTags.length) {
    throw new Error("production migration plan is unsupported");
  }
  const seenTags = new Set();
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index];
    if (
      migration?.idx !== index ||
      typeof migration.tag !== "string" ||
      seenTags.has(migration.tag)
    ) {
      throw new Error(`production migration plan mismatch at index ${index}`);
    }
    seenTags.add(migration.tag);
    if (
      index >= productionMigrationTags.length &&
      (!/^\d{4}_.+/.test(migration.tag) ||
        Number(migration.tag.slice(0, 4)) <= 17)
    ) {
      throw new Error(`production migration plan mismatch at index ${index}`);
    }
  }
  for (let index = 0; index < productionMigrationTags.length; index += 1) {
    if (migrations[index]?.tag !== productionMigrationTags[index]) {
      throw new Error(`production migration plan mismatch at index ${index}`);
    }
  }

  const allByTag = new Map(
    migrations.map(migration => [migration.tag, migration])
  );
  const supportedMigrations = productionMigrationTags.map(tag => {
    const migration = allByTag.get(tag);
    if (!migration) throw new Error(`production migration ${tag} is missing`);
    return migration;
  });
  const byTag = new Map(
    supportedMigrations.map(migration => [migration.tag, migration])
  );
  const throughTag = tag => {
    const index = supportedMigrations.findIndex(
      migration => migration.tag === tag
    );
    if (index < 0) throw new Error(`production migration ${tag} is missing`);
    return Object.freeze(supportedMigrations.slice(0, index + 1));
  };

  return Object.freeze({
    all: Object.freeze([...supportedMigrations]),
    through0014: throughTag(base0014Tag),
    through0015: throughTag(base0015Tag),
    through0016: throughTag(expand0016Tag),
    through0017: throughTag(creditWallet0017Tag),
    base0014: byTag.get(base0014Tag),
    base0015: byTag.get(base0015Tag),
    expand0016: byTag.get(expand0016Tag),
    creditWallet0017: byTag.get(creditWallet0017Tag),
  });
}
