import { describe, expect, it } from 'vitest';
import {
  validateBuilding,
  validateFloor,
  validateObservation,
  validatePlacement,
  validateWidget,
} from '../shared/validation';

const placement = {
  buildingId: 'hq',
  modelUrl: '/assets/models/hq.glb',
  u: 0.5,
  v: 0.5,
  targetWidth: 40,
  rotationDegrees: [0, 180, 0],
  verticalOffset: 0,
  label: 'HQ',
  category: 'office',
};

const building = {
  id: 'hq',
  name: 'MC² Headquarters',
  category: 'office',
  description: 'A flagship office building.',
  heightM: 80,
  floorCount: 20,
  gfaM2: 12000,
  availability: 'available',
  tags: ['office'],
  images: [{ url: '/assets/images/hq.webp', alt: 'HQ exterior' }],
  enquiryUrl: 'https://example.com/enquire',
};

const floor = {
  id: 'hq-01',
  buildingId: 'hq',
  label: 'Level 01',
  sortOrder: 1,
  areaM2: 500,
  use: 'Retail',
  description: 'Ground-floor retail.',
  drawing: { url: '/assets/drawings/hq-01.svg', alt: 'Level 01 plan' },
  isDefault: true,
};

const observation = {
  metricKey: 'occupancy',
  scope: 'mc2' as const,
  periodStart: '2026-01-01',
  periodEnd: '2026-01-31',
  value: 95,
  target: 90,
  source: 'CMS',
  isSample: false,
};

const widget = {
  id: 'occupancy-kpi',
  type: 'kpi' as const,
  title: 'Occupancy',
  metricKeys: ['occupancy'],
  order: 1,
  image: null,
};

describe('CMS data contracts', () => {
  it('accepts a valid placement', () => {
    expect(validatePlacement(placement).success).toBe(true);
  });

  it('rejects placement coordinates outside the inclusive masterplan range', () => {
    expect(validatePlacement({ ...placement, u: 1.1 }).success).toBe(false);
  });

  it('rejects a placement with a zero width or non-finite number', () => {
    expect(validatePlacement({ ...placement, targetWidth: 0 }).success).toBe(false);
    expect(validatePlacement({ ...placement, verticalOffset: Number.NaN }).success).toBe(false);
    expect(validatePlacement({ ...placement, targetWidth: Infinity }).success).toBe(false);
  });

  it('rejects unsafe model URLs and unknown placement fields', () => {
    expect(validatePlacement({ ...placement, modelUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(validatePlacement({ ...placement, extra: true }).success).toBe(false);
  });

  it('allows nullable building measurements', () => {
    expect(
      validateBuilding({ ...building, heightM: null, gfaM2: null, enquiryUrl: null }).success,
    ).toBe(true);
  });

  it('rejects invalid building floor counts and unsafe enquiry URLs', () => {
    expect(validateBuilding({ ...building, floorCount: -1 }).success).toBe(false);
    expect(validateBuilding({ ...building, floorCount: 1.5 }).success).toBe(false);
    expect(validateBuilding({ ...building, enquiryUrl: 'data:text/html,unsafe' }).success).toBe(false);
  });

  it('validates floor drawings and required floor labels', () => {
    expect(validateFloor(floor).success).toBe(true);
    expect(validateFloor({ ...floor, label: '' }).success).toBe(false);
    expect(
      validateFloor({ ...floor, drawing: { url: 'file:///tmp/floor.svg', alt: 'Unsafe' } }).success,
    ).toBe(false);
  });

  it('requires valid ordered ISO dates for observations', () => {
    expect(validateObservation(observation).success).toBe(true);
    expect(
      validateObservation({ ...observation, periodStart: '2026-02-01', periodEnd: '2026-01-31' })
        .success,
    ).toBe(false);
    expect(validateObservation({ ...observation, periodStart: '2026-02-30' }).success).toBe(false);
  });

  it('rejects non-finite observation values', () => {
    expect(validateObservation({ ...observation, value: Number.NaN }).success).toBe(false);
    expect(validateObservation({ ...observation, target: Infinity }).success).toBe(false);
  });

  it('accepts only allowlisted widget types and safe image URLs', () => {
    expect(validateWidget(widget).success).toBe(true);
    expect(validateWidget({ ...widget, type: 'map' }).success).toBe(false);
    expect(
      validateWidget({ ...widget, image: { url: 'data:image/svg+xml,unsafe', alt: 'Unsafe' } }).success,
    ).toBe(false);
  });
});
