import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { pid } from "../../lib/public-ids.js";
import { forbidden, handleRouteError, notFound, unauthorized } from "../../http/errors.js";
import { getOrgRole } from "../access/workspace-access.js";
import { writeAuditEvent } from "../audit/write.js";
import { LimitsService } from "./limits-service.js";
import { resolveBillingOrgId } from "./resolve-org.js";
import { upgradeOrgToTeamPlan } from "./subscription.js";

/** Only org owners and billing admins may change the plan. */
const BILLING_ROLES = new Set(["owner", "billing_admin"]);

const upgradeBody = z.object({
  organizationId: z.string().optional(),
  plan: z.enum(["team"]).default("team"),
});

export async function registerBillingRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const limits = new LimitsService(ctx.db);

  app.get<{ Querystring: { organizationId?: string } }>(
    "/v1/billing/plan",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          unauthorized(request, reply);
          return;
        }

        const orgId = await resolveBillingOrgId(
          ctx.db,
          user.id,
          request.query.organizationId,
        );
        if (!orgId) {
          notFound(request, reply, "Organization not found");
          return;
        }

        const plan = await limits.getOrgPlan(orgId);
        const usage = await limits.getUsage(orgId);

        const usagePublic = {
          recordsByBase: Object.fromEntries(
            Object.entries(usage.recordsByBase).map(([baseId, count]) => [
              pid("bas", baseId),
              count,
            ]),
          ),
          attachmentBytesByBase: Object.fromEntries(
            Object.entries(usage.attachmentBytesByBase).map(
              ([baseId, bytes]) => [pid("bas", baseId), bytes],
            ),
          ),
        };

        void reply.send({
          organizationId: pid("org", orgId),
          plan: {
            code: plan.planCode,
            name: plan.planName,
          },
          limits: plan.limits,
          usage: usagePublic,
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  /** In-app plan upgrade (no Stripe). Org owner/admin upgrades Free → Team. */
  app.post("/v1/billing/upgrade", async (request, reply) => {
    try {
      const user = request.user;
      if (!user) {
        unauthorized(request, reply);
        return;
      }

      const body = upgradeBody.parse(request.body ?? {});
      const orgId = await resolveBillingOrgId(
        ctx.db,
        user.id,
        body.organizationId,
      );
      if (!orgId) {
        notFound(request, reply, "Organization not found");
        return;
      }

      const role = await getOrgRole(ctx.db, user.id, orgId);
      if (!role || !BILLING_ROLES.has(role)) {
        forbidden(request, reply, "Only organization owners and billing admins can change the plan");
        return;
      }
      await upgradeOrgToTeamPlan(ctx.db, orgId);
      await writeAuditEvent(ctx.db, {
        orgId,
        actorUserId: user.id,
        action: "billing.plan_upgraded",
        targetType: "organization",
        targetId: orgId,
        metadata: { plan: "team" },
        ip: request.ip,
      });
      void reply.send({ plan: "team" as const });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });

  /** @deprecated Prefer POST /v1/billing/upgrade — kept for existing clients. */
  app.post("/v1/billing/checkout", async (request, reply) => {
    try {
      const user = request.user;
      if (!user) {
        unauthorized(request, reply);
        return;
      }

      const body = upgradeBody
        .partial()
        .parse(request.body ?? {});
      const orgId = await resolveBillingOrgId(
        ctx.db,
        user.id,
        body.organizationId,
      );
      if (!orgId) {
        notFound(request, reply, "Organization not found");
        return;
      }

      const role = await getOrgRole(ctx.db, user.id, orgId);
      if (!role || !BILLING_ROLES.has(role)) {
        forbidden(request, reply, "Only organization owners and billing admins can change the plan");
        return;
      }
      await upgradeOrgToTeamPlan(ctx.db, orgId);
      await writeAuditEvent(ctx.db, {
        orgId,
        actorUserId: user.id,
        action: "billing.plan_upgraded",
        targetType: "organization",
        targetId: orgId,
        metadata: { plan: "team" },
        ip: request.ip,
      });
      void reply.send({ mode: "in_app" as const, plan: "team" as const });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });
}
