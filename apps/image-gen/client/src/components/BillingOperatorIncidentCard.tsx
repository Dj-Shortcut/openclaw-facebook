import { Button } from "@/components/ui/button";
import {
  getBillingOperatorIncidentViews,
  type BillingOperatorIncident,
} from "./billingOperatorIncidentView";

export function BillingOperatorIncidentCard(props: {
  incidents: readonly BillingOperatorIncident[];
  isLoading: boolean;
  loadFailed: boolean;
  acknowledgementPending: boolean;
  acknowledgementFailed: boolean;
  locale: string;
  onAcknowledge: (notificationId: number) => void;
}) {
  const incidentViews = getBillingOperatorIncidentViews(
    props.incidents,
    props.locale
  );
  return (
    <section className="rounded-2xl border border-red-200 bg-red-50 p-4 text-red-950 lg:col-start-2">
      <h2 className="text-sm font-semibold">
        Billing-incidenten voor operator
      </h2>
      <p className="mt-1 text-sm leading-6 text-red-900">
        Tenantgebonden metadata voor menselijke opvolging. Provider- en
        klantinhoud worden hier niet getoond.
      </p>
      {props.isLoading ? (
        <p className="mt-3 text-sm">Incidenten laden…</p>
      ) : props.loadFailed ? (
        <p className="mt-3 text-sm font-medium">
          Incidenten konden niet worden geladen.
        </p>
      ) : incidentViews.length === 0 ? (
        <p className="mt-3 text-sm">
          Geen operatorincidenten voor deze workspace.
        </p>
      ) : (
        <ul className="mt-3 grid gap-2">
          {incidentViews.map(incident => (
            <li
              className="rounded-lg border border-red-200 bg-white p-3 text-sm"
              key={incident.id}
            >
              <div className="font-medium">{incident.eventType}</div>
              <div className="mt-1 text-red-800">{incident.reason}</div>
              <div className="mt-1 text-xs text-red-700">
                {incident.occurredLabel}
              </div>
              {!incident.canAcknowledge ? (
                <div className="mt-2 text-xs font-medium text-slate-600">
                  Gelezen {incident.readLabel}
                </div>
              ) : (
                <Button
                  className="mt-2"
                  disabled={props.acknowledgementPending}
                  onClick={() => props.onAcknowledge(incident.id)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Bevestig gelezen
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {props.acknowledgementFailed ? (
        <p className="mt-3 text-sm font-medium">
          Bevestiging is niet opgeslagen; vernieuw de incidentlijst.
        </p>
      ) : null}
    </section>
  );
}
