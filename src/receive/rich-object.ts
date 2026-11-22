/**
 * Renders Talk rich objects (`messageParameters.object`) as readable text for the agent.
 *
 * Talk shares locations, polls, deck cards and similar as `message: "{object}"` with the
 * details in the parameter. All values are untrusted input from other chat participants.
 */

type RichObjectParameter = Record<string, unknown>;

export type NextcloudTalkGeoLocation = {
  name?: string;
  /** Decimal degrees as sent by Talk (string keeps every digit). */
  latitude: string;
  longitude: string;
};

const DECIMAL = /^-?\d{1,3}(?:\.\d{1,20})?$/u;
// geo:<lat>,<lon>[,<alt>][;crs=wgs84][;u=<uncertainty>] (RFC 5870, as validated by Talk)
const GEO_URI = /^geo:(-?\d{1,3}(?:\.\d{1,20})?),(-?\d{1,3}(?:\.\d{1,20})?)(?:[,;?].*)?$/iu;
const OBJECT_TYPE = /^[a-z0-9_-]{1,64}$/u;
const MAX_NAME_LENGTH = 200;

function str(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function cleanName(value: unknown): string {
  const text = str(value)
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return text.length > MAX_NAME_LENGTH ? `${text.slice(0, MAX_NAME_LENGTH - 1)}…` : text;
}

function validCoordinates(latitude: string, longitude: string): boolean {
  if (!DECIMAL.test(latitude) || !DECIMAL.test(longitude)) {
    return false;
  }
  const lat = Number(latitude);
  const lon = Number(longitude);
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/** Coordinates from `latitude`/`longitude`, falling back to the `geo:` URI in `id`. */
export function parseNextcloudTalkGeoLocation(parameter: RichObjectParameter): NextcloudTalkGeoLocation | undefined {
  if (str(parameter.type) !== "geo-location") {
    return undefined;
  }
  let latitude = str(parameter.latitude).trim();
  let longitude = str(parameter.longitude).trim();
  if (!validCoordinates(latitude, longitude)) {
    const match = GEO_URI.exec(str(parameter.id).trim());
    if (!match || !validCoordinates(match[1]!, match[2]!)) {
      return undefined;
    }
    latitude = match[1]!;
    longitude = match[2]!;
  }
  const name = cleanName(parameter.name);
  return { ...(name ? { name } : {}), latitude, longitude };
}

function mapLink({ latitude, longitude }: NextcloudTalkGeoLocation): string {
  return `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=16/${latitude}/${longitude}`;
}

/** Text for a rich object placeholder; locations keep their coordinates. */
export function renderNextcloudTalkRichObject(parameter: RichObjectParameter): string {
  const type = str(parameter.type);
  const name = cleanName(parameter.name);
  if (type === "geo-location") {
    const location = parseNextcloudTalkGeoLocation(parameter);
    if (!location) {
      return name ? `[Location: ${name}]` : "[Location]";
    }
    const parts = [
      ...(location.name ? [location.name] : []),
      `lat ${location.latitude}, lon ${location.longitude}`,
      mapLink(location),
    ];
    return `[Location: ${parts.join(" · ")}]`;
  }
  const label = name || cleanName(parameter.id);
  if (!OBJECT_TYPE.test(type)) {
    return label;
  }
  return label ? `[Shared object (${type}): ${label}]` : `[Shared object (${type})]`;
}
