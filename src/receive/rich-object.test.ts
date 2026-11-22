import { describe, expect, it } from "vitest";
import { parseNextcloudTalkGeoLocation, renderNextcloudTalkRichObject } from "./rich-object.js";

// Shape as defined in Nextcloud's RichObjectStrings definitions (id, name, latitude, longitude).
const location = {
  type: "geo-location",
  id: "geo:48.8582602,2.2944991",
  name: "Meeting point",
  latitude: "48.8582602",
  longitude: "2.2944991",
};
const LINK = "https://www.openstreetmap.org/?mlat=48.8582602&mlon=2.2944991#map=16/48.8582602/2.2944991";

describe("rich objects", () => {
  it("renders a location with name, coordinates and map link", () => {
    expect(renderNextcloudTalkRichObject(location)).toBe(
      `[Location: Meeting point · lat 48.8582602, lon 2.2944991 · ${LINK}]`,
    );
  });

  it("takes coordinates from the geo URI when the fields are missing or invalid", () => {
    expect(
      parseNextcloudTalkGeoLocation({ type: "geo-location", id: "geo:48.8582602,2.2944991;u=35", latitude: "x" }),
    ).toEqual({ latitude: "48.8582602", longitude: "2.2944991" });
    expect(parseNextcloudTalkGeoLocation({ type: "geo-location", id: "geo:-33.9,18.4,12.5" })).toEqual({
      latitude: "-33.9",
      longitude: "18.4",
    });
  });

  it("keeps full double precision", () => {
    expect(
      parseNextcloudTalkGeoLocation({ type: "geo-location", latitude: "48.85826020000001", longitude: "9.1234567890123456" }),
    ).toEqual({ latitude: "48.85826020000001", longitude: "9.1234567890123456" });
  });

  it("accepts numeric coordinates", () => {
    expect(parseNextcloudTalkGeoLocation({ type: "geo-location", latitude: 52.5, longitude: -0.25 })).toEqual({
      latitude: "52.5",
      longitude: "-0.25",
    });
  });

  it.each([
    [{ latitude: "91", longitude: "13" }],
    [{ latitude: "52", longitude: "180.5" }],
    [{ latitude: "52.1&x=1", longitude: "13" }],
    [{ latitude: "NaN", longitude: "13" }],
    [{ latitude: "1e2", longitude: "13" }],
    [{ id: "geo:95,13" }],
    [{ id: "https://example.test/?q=52,13" }],
    [{}],
  ])("rejects invalid coordinates %j", (fields) => {
    expect(parseNextcloudTalkGeoLocation({ type: "geo-location", ...fields })).toBeUndefined();
  });

  it("keeps the label when coordinates are invalid", () => {
    expect(renderNextcloudTalkRichObject({ type: "geo-location", name: "Treffpunkt", id: "geo:x" })).toBe(
      "[Location: Treffpunkt]",
    );
    expect(renderNextcloudTalkRichObject({ type: "geo-location" })).toBe("[Location]");
  });

  it("omits a missing name and cleans control characters", () => {
    expect(renderNextcloudTalkRichObject({ ...location, name: "" })).toBe(
      `[Location: lat 48.8582602, lon 2.2944991 · ${LINK}]`,
    );
    expect(renderNextcloudTalkRichObject({ ...location, name: "Zeile 1\n\u202eZeile 2" })).toContain(
      "[Location: Zeile 1 Zeile 2 ·",
    );
    expect(renderNextcloudTalkRichObject({ ...location, name: "a".repeat(500) })).toContain(`${"a".repeat(199)}… ·`);
  });

  it("labels other object types with type and name", () => {
    expect(renderNextcloudTalkRichObject({ type: "talk-poll", id: "12", name: "Pizza oder Pasta?" })).toBe(
      "[Shared object (talk-poll): Pizza oder Pasta?]",
    );
    expect(renderNextcloudTalkRichObject({ type: "deck-card", id: "7" })).toBe("[Shared object (deck-card): 7]");
    expect(renderNextcloudTalkRichObject({ type: "call" })).toBe("[Shared object (call)]");
  });

  it("falls back to the plain label for a missing or odd type", () => {
    expect(renderNextcloudTalkRichObject({ name: "Etwas" })).toBe("Etwas");
    expect(renderNextcloudTalkRichObject({ type: "Bad Type]", name: "Etwas" })).toBe("Etwas");
  });
});
