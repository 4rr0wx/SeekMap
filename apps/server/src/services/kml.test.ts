import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { parseKml, parseKmlUpload } from "./kml";

describe("KML import", () => {
  it("converts named points and polygons to GeoJSON", () => {
    const result =
      parseKml(`<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>
      <Placemark><name>Museum A</name><Point><coordinates>16.37,48.21,0</coordinates></Point></Placemark>
      <Placemark><name>Area B</name><Polygon><outerBoundaryIs><LinearRing><coordinates>16.3,48.2 16.4,48.2 16.4,48.3 16.3,48.2</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
    </Document></kml>`);
    expect(result.features).toHaveLength(2);
    expect(result.features[0]?.properties?.name).toBe("Museum A");
    expect(result.features[1]?.geometry.type).toBe("Polygon");
  });

  it("rejects non-KML and empty KML", () => {
    expect(() => parseKml("not xml")).toThrow(/not KML/i);
    expect(() => parseKml("<kml><Document/></kml>")).toThrow(/no supported features/i);
  });

  it("extracts and converts a KMZ archive", () => {
    const archive = zipSync({
      "places.kml": strToU8(
        `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>
        <Placemark><name>Prater</name><Point><coordinates>16.4,48.2</coordinates></Point></Placemark>
        </Document></kml>`,
      ),
    });
    const result = parseKmlUpload(archive, "places.kmz");
    expect(result.features).toHaveLength(1);
    expect(result.features[0]?.properties?.name).toBe("Prater");
  });
});
