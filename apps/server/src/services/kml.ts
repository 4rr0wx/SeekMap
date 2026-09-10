import { kml } from "@tmcw/togeojson";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import type { FeatureCollection, Geometry } from "geojson";
import type { MapFeatureCollection } from "@hideseek/shared";

const allowedGeometry = new Set([
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
]);

function sanitizeProperties(
  properties: Record<string, unknown> | null,
): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (["string", "number", "boolean"].includes(typeof value) || value === null) {
      result[key.slice(0, 100)] = value as string | number | boolean | null;
    }
  }
  return result;
}

function coordinatesAreFinite(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  return Array.isArray(value) && value.length > 0 && value.every(coordinatesAreFinite);
}

export function parseKml(text: string, maxFeatures = 20_000): MapFeatureCollection {
  if (!/<kml[\s>]/i.test(text)) throw new Error("The uploaded file is not KML");
  const xml = new DOMParser({ errorHandler: () => undefined }).parseFromString(text, "text/xml");
  if (xml.getElementsByTagName("parsererror").length > 0)
    throw new Error("The KML XML is malformed");
  const converted = kml(xml) as FeatureCollection<Geometry>;
  if (converted.type !== "FeatureCollection" || converted.features.length === 0) {
    throw new Error("The KML contains no supported features");
  }
  if (converted.features.length > maxFeatures)
    throw new Error(`KML contains more than ${maxFeatures} features`);

  const features = converted.features.map((feature) => {
    if (!feature.geometry || !allowedGeometry.has(feature.geometry.type)) {
      throw new Error("KML contains an unsupported geometry");
    }
    if (
      !("coordinates" in feature.geometry) ||
      !coordinatesAreFinite(feature.geometry.coordinates)
    ) {
      throw new Error("KML contains invalid coordinates");
    }
    return {
      ...feature,
      properties: sanitizeProperties(feature.properties as Record<string, unknown> | null),
    };
  });
  return { type: "FeatureCollection", features } as MapFeatureCollection;
}

export function parseKmlUpload(
  data: Uint8Array,
  filename: string,
  maxFeatures = 20_000,
  maxUncompressedBytes = 20 * 1024 * 1024,
): MapFeatureCollection {
  if (!filename.toLocaleLowerCase().endsWith(".kmz")) {
    return parseKml(strFromU8(data), maxFeatures);
  }

  let extracted: Record<string, Uint8Array>;
  try {
    extracted = unzipSync(data, {
      filter(file) {
        if (!file.name.toLocaleLowerCase().endsWith(".kml")) return false;
        if (file.originalSize > maxUncompressedBytes) {
          throw new Error("The KML inside this KMZ is too large");
        }
        return true;
      },
    });
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("too large")) throw cause;
    throw new Error("The uploaded KMZ archive is invalid");
  }

  const entries = Object.entries(extracted).filter(([name]) =>
    name.toLocaleLowerCase().endsWith(".kml"),
  );
  if (entries.length === 0) throw new Error("The KMZ archive contains no KML file");
  const preferred = entries.find(([name]) => /(^|\/)doc\.kml$/i.test(name)) ?? entries[0]!;
  return parseKml(strFromU8(preferred[1]), maxFeatures);
}
