import { describe, expect, it } from 'vitest';
import { classifyReadFailure } from '../src/server/public/read-failure';

describe('classifyReadFailure', () => {
  it('names a database that is behind the code (missing column/table), however the driver wraps it', () => {
    const pg = Object.assign(new Error('column events.short_title does not exist'), { code: '42703' });
    const drizzle = Object.assign(new Error('Failed query: select …'), { cause: pg });
    expect(classifyReadFailure(drizzle)).toBe('schema-behind');
    expect(classifyReadFailure(new Error('relation "project_credits" does not exist'))).toBe('schema-behind');
    expect(classifyReadFailure(Object.assign(new Error('x'), { code: '42P01' }))).toBe('schema-behind');
  });

  it('everything else is simply unavailable', () => {
    expect(classifyReadFailure(new Error('connect ECONNREFUSED 127.0.0.1:5432'))).toBe('unavailable');
    expect(classifyReadFailure(Object.assign(new Error('timeout'), { code: '57014' }))).toBe('unavailable');
    expect(classifyReadFailure(null)).toBe('unavailable');
  });
});
