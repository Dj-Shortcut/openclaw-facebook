import { systemRouter } from "./_core/systemRouter";
import { billingAdminRouter } from "./_core/billing/billingAdminRouter";
import { router } from "./_core/trpc";

export const appRouter = router({
  system: systemRouter,
  billingAdmin: billingAdminRouter,
});

export type AppRouter = typeof appRouter;
