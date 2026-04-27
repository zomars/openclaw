export type DisqualificationReason = "out_of_state" | "tenant" | "low_bill";

const TEMPLATES: Record<DisqualificationReason, string> = {
  out_of_state: "Por el momento solo operamos en Sinaloa. Agradezco su interés.",
  tenant:
    "La instalación requiere ser propietario del inmueble. Le sugiero comentarlo con el dueño.",
  low_bill:
    "Con ese nivel de consumo el retorno de inversión sería muy largo. En este momento no sería conveniente para usted.",
};

export function disqualificationMessage(reason: DisqualificationReason): string {
  return TEMPLATES[reason];
}

export function isDisqualificationReason(value: unknown): value is DisqualificationReason {
  return value === "out_of_state" || value === "tenant" || value === "low_bill";
}
