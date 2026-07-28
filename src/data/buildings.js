// Site dimensions in world units — matches the masterplan aspect (~1.20).
export const PW = 224;
export const PH = 186;

export const wx = (u) => (u - 0.5) * PW;
export const wz = (v) => (v - 0.5) * PH;

export const USE_COLORS = {
  office: "#6f8bb0",
  retail: "#e0a24e",
  hotel: "#c07a54",
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

// Buildings matched to the render composition.
// u,v = centre; w,d = size — all normalized 0..1 across the site plate.
export const BUILDINGS = [
  {
    id: "T", name: "The Terraces — Office", useKey: "office", use: "Grade-A Offices",
    shape: "wavy", color: 0xb06a4a, u: 0.22, v: 0.44, w: 0.21, d: 0.30,
    floors: 6, gfa: "24,800", avail: "4 floors", img: "street", fp: 0,
    blurb: "The terracotta perimeter block — deep vertical fins wrapping a C-shaped courtyard, warm-lit at dusk.",
    tags: ["LEED Platinum", "Terracotta fins", "Column-free", "Courtyard"],
  },
  {
    id: "A", name: "Office Block A", useKey: "office", use: "Grade-A Offices",
    shape: "wavy", color: 0xbdb4a4, u: 0.38, v: 0.60, w: 0.15, d: 0.15,
    floors: 5, gfa: "15,200", avail: "2 floors", img: "street", fp: 1,
    blurb: "Wavy-edged block with a grey plant roof, opening to the landscaped street.",
    tags: ["LEED Platinum", "Roof plant", "Flexible floors"],
  },
  {
    id: "B", name: "Office Block B", useKey: "office", use: "Grade-A Offices",
    shape: "wavy", color: 0xbdb4a4, u: 0.38, v: 0.81, w: 0.15, d: 0.16,
    floors: 5, gfa: "15,600", avail: "Full building", img: "street", fp: 0,
    blurb: "Front-row block addressing the boulevard, with active retail frontage at grade.",
    tags: ["LEED Platinum", "Retail frontage", "WELL Gold"],
  },
  {
    id: "C", name: "Office Block C", useKey: "office", use: "Grade-A Offices",
    shape: "wavy", color: 0xbdb4a4, u: 0.56, v: 0.60, w: 0.16, d: 0.15,
    floors: 6, gfa: "18,900", avail: "1 floor", img: "street", fp: 1,
    blurb: "Central block on the retail spine, with a double-height lobby.",
    tags: ["LEED Platinum", "Sky lobby", "Column-free"],
  },
  {
    id: "H", name: "Retail Galleria", useKey: "retail", use: "Retail & F&B",
    shape: "wavy", color: 0xc79a5e, u: 0.56, v: 0.81, w: 0.16, d: 0.16,
    floors: 3, gfa: "11,400", avail: "Leasing now", img: "street", fp: 2,
    blurb: "The shaded, naturally-ventilated retail spine of cafés and restaurants.",
    tags: ["F&B", "Naturally shaded", "Terraces"],
  },
  {
    id: "D", name: "Office Block D", useKey: "office", use: "Grade-A Offices",
    shape: "wavy", color: 0xbdb4a4, u: 0.69, v: 0.71, w: 0.12, d: 0.17,
    floors: 6, gfa: "16,100", avail: "2 floors", img: "street", fp: 1,
    blurb: "East block linking through to the solar-canopy landmarks.",
    tags: ["LEED Platinum", "Bridge link", "PV shading"],
  },
  {
    id: "HQ", name: "The Solar Canopy — HQ", useKey: "hq", use: "HQ / Anchor",
    shape: "folded", color: 0x9a968f, u: 0.75, v: 0.26, w: 0.23, d: 0.20,
    floors: 7, gfa: "28,400", avail: "Anchor available", img: "aerial", fp: 1,
    blurb: "The folded photovoltaic canopy — a faceted solar roof crowning the anchor headquarters.",
    tags: ["Net Zero Energy", "Folded PV roof", "Naming rights", "Build-to-suit"],
  },
  {
    id: "HT", name: "The Solar Oculus — Hotel", useKey: "hotel", use: "Hotel & Conference",
    shape: "oval", color: 0x9a968f, u: 0.83, v: 0.53, w: 0.17, d: 0.23,
    floors: 6, gfa: "22,600", avail: "Operator LOI", img: "aerial", fp: 1,
    blurb: "The oval solar shell with an open oculus over a garden atrium — the icon of the square.",
    tags: ["Signature form", "Solar shell", "Oculus atrium", "Rooftop bar"],
  },
];
