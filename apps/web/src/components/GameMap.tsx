import { useEffect, useMemo, useRef } from "react";
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from "maplibre-gl";
import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, Geometry, Point } from "geojson";
import {
  thermometerDivider,
  type GameState,
  type MapFeature,
  type MapFeatureCollection,
  type PublicConfig,
} from "@hideseek/shared";

export interface MapLayers {
  possibleArea: boolean;
  questionGeometry: boolean;
  administrative: boolean;
  transitLines: boolean;
  transitStations: boolean;
  datasets: boolean;
  markers: boolean;
}

interface Props {
  state: GameState;
  config: PublicConfig;
  layers: MapLayers;
  localPosition: [number, number] | null;
  measurement: [number, number][];
  draftQuestionActive: boolean;
  draftQuestionPoints: Partial<Record<"A" | "B", [number, number]>>;
  draftQuestionGeometry: MapFeatureCollection | MapFeature | null;
  selectedQuestionId: string | null;
  interactionActive: boolean;
  onMapClick: (point: [number, number]) => void;
}

const empty: FeatureCollection = { type: "FeatureCollection", features: [] };

function collection(features: Array<Feature<Geometry> | null | undefined>): FeatureCollection {
  return { type: "FeatureCollection", features: features.filter(Boolean) as Feature<Geometry>[] };
}

function setData(map: MapLibreMap, source: string, data: FeatureCollection | Feature<Geometry>) {
  (map.getSource(source) as GeoJSONSource | undefined)?.setData(data);
}

function visibility(map: MapLibreMap, layer: string, visible: boolean) {
  if (map.getLayer(layer)) map.setLayoutProperty(layer, "visibility", visible ? "visible" : "none");
}

function applyLayerVisibility(map: MapLibreMap, layers: MapLayers, questionFocused = false) {
  visibility(map, "possible-fill", layers.possibleArea);
  visibility(map, "possible-line", layers.possibleArea && !questionFocused);
  visibility(map, "question-fill", layers.questionGeometry);
  visibility(map, "question-line", layers.questionGeometry);
  visibility(map, "question-divider-line", layers.questionGeometry);
  visibility(map, "question-point", layers.questionGeometry);
  visibility(map, "admin-line", layers.administrative);
  visibility(map, "transit-line", layers.transitLines);
  visibility(map, "station-circle", layers.transitStations);
  visibility(map, "dataset-fill", layers.datasets);
  visibility(map, "dataset-line", layers.datasets);
  visibility(map, "dataset-point", layers.datasets);
  visibility(map, "marker-circle", layers.markers);
}

export function GameMap({
  state,
  config,
  layers,
  localPosition,
  measurement,
  draftQuestionActive,
  draftQuestionPoints,
  draftQuestionGeometry,
  selectedQuestionId,
  interactionActive,
  onMapClick,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const onClickRef = useRef(onMapClick);
  const layersRef = useRef(layers);
  const questionFocusedRef = useRef(false);
  onClickRef.current = onMapClick;
  layersRef.current = layers;

  const selectedQuestion = selectedQuestionId
    ? state.questions.find((question) => question.id === selectedQuestionId)
    : null;
  const questionFocused =
    draftQuestionActive || Boolean(selectedQuestion && selectedQuestion.status !== "APPLIED");
  questionFocusedRef.current = questionFocused;

  const visibleStations = useMemo(() => {
    const source = state.game.transitStations;
    if (!source || !state.game.possibleArea) return empty as FeatureCollection<Point>;
    return turf.featureCollection(
      source.features.filter((station) =>
        turf.booleanPointInPolygon(station, state.game.possibleArea!),
      ),
    );
  }, [state.game.transitStations, state.game.possibleArea]);

  const importedDatasets = useMemo(
    () => turf.featureCollection(state.datasets.flatMap((dataset) => dataset.geojson.features)),
    [state.datasets],
  );

  const liveDraftPoints = useMemo(
    () =>
      collection(
        (["A", "B"] as const).map((target) => {
          const point = draftQuestionPoints[target];
          return point ? turf.point(point, { draftTarget: target }) : null;
        }),
      ),
    [draftQuestionPoints],
  );

  const questionGeometry = useMemo(() => {
    const persisted = draftQuestionActive
      ? []
      : state.questions
          .filter(
            (question) =>
              question.enabled &&
              question.visualization &&
              (!selectedQuestionId || question.id === selectedQuestionId),
          )
          .map((question) => {
            const visual = question.visualization;
            if (!visual) return null;
            if (visual.type === "FeatureCollection") {
              return visual.features.map((feature) => ({
                ...feature,
                properties: {
                  ...(feature.properties ?? {}),
                  questionId: question.id,
                  selected: question.id === selectedQuestionId,
                  status: question.status,
                },
              }));
            }
            return {
              ...visual,
              properties: {
                ...(visual.properties ?? {}),
                questionId: question.id,
                selected: question.id === selectedQuestionId,
                status: question.status,
              },
            };
          })
          .flat();
    const draftFeatures = !draftQuestionGeometry
      ? []
      : draftQuestionGeometry.type === "FeatureCollection"
        ? draftQuestionGeometry.features
        : [draftQuestionGeometry];
    const preview = draftFeatures.map((feature) => ({
      ...feature,
      properties: {
        ...(feature.properties ?? {}),
        questionId: "draft-preview",
        selected: true,
        preview: true,
        status: "DRAFT",
      },
    }));
    const start = draftQuestionPoints.A;
    const end = draftQuestionPoints.B;
    const thermometerFallback =
      draftQuestionActive && start && end && draftFeatures.length === 0
        ? [
            turf.lineString([start, end], {
              artifactRole: "reference-line",
              selected: true,
              preview: true,
            }),
            {
              ...thermometerDivider(state.game.boundary, start, end),
              properties: { artifactRole: "decision-boundary", selected: true, preview: true },
            },
          ]
        : [];
    return collection([...persisted, ...preview, ...thermometerFallback]);
  }, [
    state.game.boundary,
    state.questions,
    selectedQuestionId,
    draftQuestionActive,
    draftQuestionGeometry,
    draftQuestionPoints,
  ]);

  useEffect(() => {
    if (!container.current || mapRef.current) return;
    const center = turf.centroid(state.game.boundary).geometry.coordinates as [number, number];
    const map = new maplibregl.Map({
      container: container.current,
      center,
      zoom: 9,
      attributionControl: false,
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: [config.tileUrl],
            tileSize: 256,
            attribution: config.tileAttribution,
          },
        },
        layers: [
          {
            id: "osm",
            type: "raster",
            source: "osm",
            paint: { "raster-saturation": -0.45, "raster-brightness-max": 0.86 },
          },
        ],
      },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    map.on("load", () => {
      const sources = [
        "boundary",
        "possible",
        "questions",
        "admin",
        "transit-lines",
        "transit-stations",
        "datasets",
        "markers",
        "local-position",
        "measurement",
        "question-draft-point",
      ];
      for (const source of sources) map.addSource(source, { type: "geojson", data: empty });
      map.addLayer({
        id: "boundary-fill",
        type: "fill",
        source: "boundary",
        paint: { "fill-color": "#152522", "fill-opacity": 0.16 },
      });
      map.addLayer({
        id: "boundary-line",
        type: "line",
        source: "boundary",
        paint: { "line-color": "#314b45", "line-width": 3 },
      });
      map.addLayer({
        id: "possible-fill",
        type: "fill",
        source: "possible",
        paint: { "fill-color": "#f5b942", "fill-opacity": 0.25 },
      });
      map.addLayer({
        id: "possible-line",
        type: "line",
        source: "possible",
        paint: { "line-color": "#e9952f", "line-width": 3 },
      });
      map.addLayer({
        id: "admin-line",
        type: "line",
        source: "admin",
        paint: { "line-color": "#637f77", "line-width": 1.5, "line-dasharray": [2, 2] },
      });
      map.addLayer({
        id: "transit-line",
        type: "line",
        source: "transit-lines",
        paint: { "line-color": "#347e9b", "line-width": 2.5, "line-opacity": 0.8 },
      });
      map.addLayer({
        id: "question-fill",
        type: "fill",
        source: "questions",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: {
          "fill-color": [
            "case",
            ["==", ["get", "artifactRole"], "answer-region"],
            "#f5b942",
            ["get", "selected"],
            "#f06a47",
            "#c35dbe",
          ],
          "fill-opacity": [
            "case",
            ["==", ["get", "artifactRole"], "candidate-region"],
            0.08,
            ["==", ["get", "artifactRole"], "answer-region"],
            0.24,
            0.14,
          ],
        },
      });
      map.addLayer({
        id: "question-line",
        type: "line",
        source: "questions",
        filter: [
          "all",
          ["!=", ["get", "artifactRole"], "decision-boundary"],
          ["!=", ["get", "artifactRole"], "answer-region"],
          ["!=", ["get", "artifactRole"], "candidate-region"],
        ],
        paint: {
          "line-color": ["case", ["get", "selected"], "#f06a47", "#8f4b91"],
          "line-width": ["case", ["get", "selected"], 4, 2],
        },
      });
      map.addLayer({
        id: "question-divider-line",
        type: "line",
        source: "questions",
        filter: [
          "in",
          ["get", "artifactRole"],
          ["literal", ["decision-boundary", "candidate-region"]],
        ],
        paint: {
          "line-color": "#f5b942",
          "line-width": 3,
          "line-dasharray": [2, 2],
        },
      });
      map.addLayer({
        id: "question-point",
        type: "circle",
        source: "questions",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": ["case", ["==", ["get", "artifactRole"], "dataset-place"], 4, 7],
          "circle-color": [
            "case",
            ["==", ["get", "artifactRole"], "thermometer-start"],
            "#347e9b",
            ["==", ["get", "artifactRole"], "thermometer-end"],
            "#f06a47",
            ["==", ["get", "artifactRole"], "seeker-reference"],
            "#f5b942",
            "#c35dbe",
          ],
          "circle-opacity": ["case", ["==", ["get", "artifactRole"], "dataset-place"], 0.65, 1],
          "circle-stroke-color": "#fff5df",
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "station-circle",
        type: "circle",
        source: "transit-stations",
        paint: {
          "circle-radius": 5,
          "circle-color": "#f5f2e8",
          "circle-stroke-color": "#246880",
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "dataset-fill",
        type: "fill",
        source: "datasets",
        paint: { "fill-color": "#347e9b", "fill-opacity": 0.18 },
      });
      map.addLayer({
        id: "dataset-line",
        type: "line",
        source: "datasets",
        paint: { "line-color": "#347e9b", "line-width": 2 },
      });
      map.addLayer({
        id: "dataset-point",
        type: "circle",
        source: "datasets",
        paint: {
          "circle-radius": 5,
          "circle-color": "#347e9b",
          "circle-stroke-color": "#f5f2e8",
          "circle-stroke-width": 1.5,
        },
      });
      map.addLayer({
        id: "marker-circle",
        type: "circle",
        source: "markers",
        paint: {
          "circle-radius": 7,
          "circle-color": "#f06a47",
          "circle-stroke-color": "#fff5df",
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "measurement-line",
        type: "line",
        source: "measurement",
        paint: { "line-color": "#f06a47", "line-width": 4, "line-dasharray": [2, 1] },
      });
      map.addLayer({
        id: "question-draft-point",
        type: "circle",
        source: "question-draft-point",
        paint: {
          "circle-radius": 9,
          "circle-color": ["case", ["==", ["get", "draftTarget"], "A"], "#347e9b", "#f06a47"],
          "circle-stroke-color": "#fff5df",
          "circle-stroke-width": 3,
        },
      });
      map.addLayer({
        id: "local-position",
        type: "circle",
        source: "local-position",
        paint: {
          "circle-radius": 8,
          "circle-color": "#2786d1",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 3,
        },
      });
      setData(map, "boundary", state.game.boundary);
      setData(map, "possible", state.game.possibleArea ?? empty);
      setData(map, "questions", questionGeometry);
      setData(map, "admin", state.game.subdivisions ?? empty);
      setData(map, "transit-lines", state.game.transitLines ?? empty);
      setData(map, "transit-stations", visibleStations);
      setData(map, "datasets", importedDatasets);
      setData(
        map,
        "markers",
        collection((state.seekerMarkers ?? []).map((marker) => marker.position)),
      );
      setData(map, "local-position", localPosition ? turf.point(localPosition) : empty);
      setData(map, "question-draft-point", liveDraftPoints);
      applyLayerVisibility(map, layersRef.current, questionFocusedRef.current);
      const bounds = turf.bbox(state.game.boundary);
      map.fitBounds(
        [
          [bounds[0], bounds[1]],
          [bounds[2], bounds[3]],
        ],
        { padding: 42, duration: 0 },
      );
      map.fire("hideseek-ready");
    });
    map.on("click", (event) => onClickRef.current([event.lngLat.lng, event.lngLat.lat]));
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [config.tileAttribution, config.tileUrl, state.game.boundary]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    setData(map, "boundary", state.game.boundary);
    setData(map, "possible", state.game.possibleArea ?? empty);
    setData(map, "questions", questionGeometry);
    setData(map, "admin", state.game.subdivisions ?? empty);
    setData(map, "transit-lines", state.game.transitLines ?? empty);
    setData(map, "transit-stations", visibleStations);
    setData(map, "datasets", importedDatasets);
    setData(
      map,
      "markers",
      collection((state.seekerMarkers ?? []).map((marker) => marker.position)),
    );
    setData(map, "local-position", localPosition ? turf.point(localPosition) : empty);
    setData(map, "question-draft-point", liveDraftPoints);
    setData(map, "measurement", measurement.length === 2 ? turf.lineString(measurement) : empty);
    applyLayerVisibility(map, layers, questionFocused);
  }, [
    state,
    layers,
    localPosition,
    draftQuestionPoints,
    liveDraftPoints,
    measurement,
    questionGeometry,
    questionFocused,
    visibleStations,
    importedDatasets,
  ]);

  return (
    <div
      ref={container}
      className={interactionActive ? "map interaction-active" : "map"}
      aria-label="Game map"
    />
  );
}
