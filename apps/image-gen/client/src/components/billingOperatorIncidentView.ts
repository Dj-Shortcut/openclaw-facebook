export type BillingOperatorIncident = Readonly<{
  id: number;
  eventType: string;
  reason: string;
  occurredAt: Date;
  readAt: Date | null;
}>;

export type BillingOperatorIncidentView = Readonly<{
  id: number;
  eventType: string;
  reason: string;
  occurredLabel: string;
  readLabel: string | null;
  canAcknowledge: boolean;
}>;

export function getBillingOperatorIncidentViews(
  incidents: readonly BillingOperatorIncident[],
  locale: string
): BillingOperatorIncidentView[] {
  const formatter = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return incidents.map(incident => ({
    id: incident.id,
    eventType: incident.eventType,
    reason: incident.reason,
    occurredLabel: formatter.format(incident.occurredAt),
    readLabel: incident.readAt ? formatter.format(incident.readAt) : null,
    canAcknowledge: incident.readAt === null,
  }));
}
