// Site dimensions in world units — matches the masterplan aspect (~1.20).
export const PW = 224;
export const PH = 186;

export const wx = (u) => (u - 0.5) * PW;
export const wz = (v) => (v - 0.5) * PH;

export const USE_COLORS = {
  office: "#6f8bb0",
  retail: "#e0a24e",
  hq: "#5f9c6f",
  amenity: "#4fa3a0",
  community: "#cbb48a",
};

export const IMAGES = {
  aerial: "/assets/aerial.jpg",
  street: "/assets/street.jpg",
};

export const MASTERPLAN = "/assets/masterplan.jpg";

export const FLOORPLATES = [
  "/assets/floorplate-0.jpg",
  "/assets/floorplate-1.jpg",
  "/assets/floorplate-2.jpg",
];

// Imported GLB models, placed across the site plate — u,v = centre,
// normalized 0..1. One landmark anchors the centre; four sit at the
// corners and two at the east/west mid-edges, each spaced so its
// targetWidth footprint clears its neighbours' with visible margin.
// Same clickable/selectable data shape consumed directly by createScene's
// GLTFLoader pass.
export const GLB_BUILDINGS = [
  {
    id: "SA", name: "The Wave — Innovation Center", useKey: "hq", use: "HQ / Anchor",
    asset: "/assets/space_agency_wave_building.glb", u: 0.50, v: 0.50, targetWidth: 100,
    floors: 3, gfa: "14,600", avail: "Anchor available", img: "aerial", fp: 1,
    blurb: "A folded, ribbon-like anchor building at the heart of the square — the landmark research and innovation centre the plaza is organised around.",
    tags: ["Landmark form", "Anchor available", "Innovation hub"],
  },
  {
    id: "CY", name: "The Courtyard Pavilion", useKey: "amenity", use: "Community & Amenity",
    asset: "/assets/courtyard_building_webgl.glb", u: 0.13, v: 0.13, targetWidth: 65,
    floors: 4, gfa: "9,200", avail: "Leasing now", img: "street", fp: 0,
    blurb: "A low courtyard block framing a shaded internal garden — informal amenity space at the northwest corner of the plaza.",
    tags: ["Courtyard garden", "Shaded arcade", "Community use"],
  },
  {
    id: "CD", name: "Crystal Dunes", useKey: "retail", use: "Retail & F&B",
    asset: "/assets/crystal_dunes.glb", u: 0.87, v: 0.13, targetWidth: 60,
    floors: 2, gfa: "6,400", avail: "Leasing now", img: "aerial", fp: 2,
    blurb: "A low, dune-shaped retail pavilion with a faceted crystalline roof — an informal market hall at the northeast corner.",
    tags: ["Faceted roof", "Daylighting", "Market hall"],
  },
  {
    id: "OT", name: "Oasis Terraces", useKey: "amenity", use: "Community & Amenity",
    asset: "/assets/oasis_terraces.glb", u: 0.87, v: 0.90, targetWidth: 75,
    floors: 4, gfa: "10,100", avail: "Leasing now", img: "street", fp: 1,
    blurb: "Stepped terraces cascading toward a shaded oasis garden at the southeast corner — a wellness and community retreat.",
    tags: ["Stepped terraces", "Oasis garden", "Wellness"],
  },
  {
    id: "DR", name: "Desert Ribbon", useKey: "office", use: "Grade-A Offices",
    asset: "/assets/desert_ribbon.glb", u: 0.13, v: 0.90, targetWidth: 80,
    floors: 5, gfa: "12,800", avail: "3 floors", img: "street", fp: 0,
    blurb: "An elongated ribbon-form office block along the southwest edge, wrapped in a continuous brise-soleil.",
    tags: ["Ribbon form", "Brise-soleil shading", "Column-free"],
  },
  {
    id: "SC", name: "Solar Canyon", useKey: "office", use: "Grade-A Offices",
    asset: "/assets/solar_canyon.glb", u: 0.08, v: 0.50, targetWidth: 55,
    floors: 4, gfa: "8,600", avail: "2 floors", img: "street", fp: 1,
    blurb: "A narrow, canyon-like office block wrapped in deep solar louvres — a shaded corridor building on the square's west flank.",
    tags: ["Solar louvres", "Shaded canyon", "Column-free"],
  },
  {
    id: "SB", name: "Sky Bridge Forum", useKey: "community", use: "Civic & Community",
    asset: "/assets/sky_bridge_forum.glb", u: 0.92, v: 0.50, targetWidth: 55,
    floors: 3, gfa: "7,800", avail: "Leasing now", img: "aerial", fp: 2,
    blurb: "A civic forum building linked by an elevated sky bridge — a gathering hall and events space on the square's east flank.",
    tags: ["Sky bridge link", "Civic forum", "Events hall"],
  },
];
