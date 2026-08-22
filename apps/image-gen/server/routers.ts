import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { portalRouter } from "./_core/portalRouter";
import { systemRouter } from "./_core/systemRouter";
import { billingAdminRouter } from "./_core/billing/billingAdminRouter";
import { privacyAdminRouter } from "./_core/privacyAdminRouter";
import { publicProcedure, router } from "./_core/trpc";

export const appRouter = router({
  system: systemRouter,
  billingAdmin: billingAdminRouter,
  privacyAdmin: privacyAdminRouter,
  portal: portalRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),
});

export type AppRouter = typeof appRouter;
