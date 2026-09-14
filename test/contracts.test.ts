import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  validateBuilding,
  validateFloor,
  validateObservation,
  validatePlacement,
  validateWidget,
} from '../shared/validation.ts';

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
  scope: 'mc2',
  periodStart: '2026-01-01',
  periodEnd: '2026-01-31',
  value: 95,
  target: 90,
  source: 'CMS',
  isSample: false,
};

const widget = {
  id: 'occupancy-kpi',
  type: 'kpi',
  title: 'Occupancy',
  metricKeys: ['occupancy'],
  order: 1,
  image: null,
};

describe('CMS data contracts', () => {
  it('accepts placements at inclusive masterplan boundaries', () => {
    assert.equal(validatePlacement(placement).success, true);
    assert.equal(validatePlacement({ ...placement, u: 0, v: 1 }).success, true);
    assert.equal(validatePlacement({ ...placement, u: 1, v: 0 }).success, true);
  });

  it('rejects placement coordinates outside the inclusive masterplan range', () => {
    assert.equal(validatePlacement({ ...placement, u: 1.1 }).success, false);
    assert.equal(validatePlacement({ ...placement, v: -0.01 }).success, false);
  });

  it('rejects a placement with a zero width or non-finite number', () => {
    assert.equal(validatePlacement({ ...placement, targetWidth: 0 }).success, false);
    assert.equal(validatePlacement({ ...placement, verticalOffset: Number.NaN }).success, false);
    assert.equal(validatePlacement({ ...placement, targetWidth: Infinity }).success, false);
  });

  it('rejects unsafe model URLs and unknown placement fields', () => {
    assert.equal(validatePlacement({ ...placement, modelUrl: 'javascript:alert(1)' }).success, false);
    assert.equal(validatePlacement({ ...placement, modelUrl: '/assets/../admin.glb' }).success, false);
    assert.equal(
      validatePlacement({ ...placement, modelUrl: 'https://user:pass@example.com/model.glb' }).success,
      false,
    );
    assert.equal(validatePlacement({ ...placement, extra: true }).success, false);
  });

  it('allows nullable building measurements and rejects unknown building fields', () => {
    assert.equal(
      validateBuilding({ ...building, heightM: null, gfaM2: null, enquiryUrl: null }).success,
      true,
    );
    assert.equal(validateBuilding({ ...building, extra: true }).success, false);
  });

  it('rejects invalid building floor counts and unsafe enquiry URLs', () => {
    assert.equal(validateBuilding({ ...building, floorCount: -1 }).success, false);
    assert.equal(validateBuilding({ ...building, floorCount: 1.5 }).success, false);
    assert.equal(
      validateBuilding({ ...building, enquiryUrl: 'data:text/html,unsafe' }).success,
      false,
    );
  });

  it('validates nullable floor fields, required labels, and drawing URLs', () => {
    assert.equal(validateFloor({ ...floor, areaM2: null, drawing: null }).success, true);
    assert.equal(validateFloor({ ...floor, label: '' }).success, false);
    assert.equal(
      validateFloor({ ...floor, drawing: { url: 'file:///tmp/floor.svg', alt: 'Unsafe' } }).success,
      false,
    );
    assert.equal(validateFloor({ ...floor, extra: true }).success, false);
  });

  it('accepts valid ISO dates and rejects invalid or out-of-order periods', () => {
    assert.equal(validateObservation(observation).success, true);
    assert.equal(
      validateObservation({ ...observation, periodStart: '2026-02-01', periodEnd: '2026-01-31' })
        .success,
      false,
    );
    assert.equal(validateObservation({ ...observation, periodStart: '2026-02-30' }).success, false);
  });

  it('allows nullable observations and rejects non-finite values and unknown fields', () => {
    assert.equal(validateObservation({ ...observation, value: null, target: null }).success, true);
    assert.equal(validateObservation({ ...observation, value: Number.NaN }).success, false);
    assert.equal(validateObservation({ ...observation, target: Infinity }).success, false);
    assert.equal(validateObservation({ ...observation, extra: true }).success, false);
  });

  it('accepts only allowlisted widget types, safe image URLs, and known fields', () => {
    assert.equal(validateWidget(widget).success, true);
    assert.equal(validateWidget({ ...widget, type: 'map' }).success, false);
    assert.equal(
      validateWidget({ ...widget, image: { url: 'data:image/svg+xml,unsafe', alt: 'Unsafe' } }).success,
      false,
    );
    assert.equal(validateWidget({ ...widget, extra: true }).success, false);
  });
});
