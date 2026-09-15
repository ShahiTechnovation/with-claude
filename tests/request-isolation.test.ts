import { describe, it, expect } from 'vitest';
import { RecordSelectors } from '../src/data/selectors';
import type { RecordSet } from '../src/data/source';

describe('Request Isolation', () => {
  it('safely interleaves concurrent requests without state pollution', async () => {
    // We simulate Request A and Request B fetching their own isolated RecordSets from the DB.
    
    // Simulate Request A loading its RecordSet
    const rsA = {
      ambassadors: [], builders: [], cities: [{ slug: 'city-a', name: 'City A', region: 'Region A', status: 'published' as const }], events: [], guides: [], projects: [], stories: [], useCases: []
    } as unknown as RecordSet;
    
    // Simulate Request B loading its RecordSet
    const rsB = {
      ambassadors: [], builders: [], cities: [{ slug: 'city-b', name: 'City B', region: 'Region B', status: 'published' as const }], events: [], guides: [], projects: [], stories: [], useCases: []
    } as unknown as RecordSet;

    let aSelectors: RecordSelectors;
    let bSelectors: RecordSelectors;

    const reqA = async () => {
      aSelectors = new RecordSelectors(rsA);
      // Simulate yielding to event loop, representing async components running
      await new Promise(resolve => setTimeout(resolve, 10));
      return aSelectors.cityName('city-a');
    };

    const reqB = async () => {
      // Simulate delay so Request B starts while A is paused
      await new Promise(resolve => setTimeout(resolve, 5));
      bSelectors = new RecordSelectors(rsB);
      return bSelectors.cityName('city-b');
    };

    // Interleave the requests concurrently
    const [resA, resB] = await Promise.all([reqA(), reqB()]);

    expect(resA).toBe('City A');
    expect(resB).toBe('City B');
    
    // And even after both complete, A still sees only A, B still sees only B
    expect(aSelectors!.cityName('city-a')).toBe('City A');
    expect(aSelectors!.cityName('city-b')).toBe('city-b'); // Not found, falls back to slug
    
    expect(bSelectors!.cityName('city-b')).toBe('City B');
    expect(bSelectors!.cityName('city-a')).toBe('city-a'); // Not found, falls back to slug
  });

  it('proves the old module-global __setRecords approach fails under concurrency', async () => {
    // We import the real module-global state from dataset.ts
    const { __setRecords, records } = await import('../src/data/dataset');

    // Simulate Request A loading its RecordSet
    const rsA = {
      ambassadors: [], builders: [], cities: [{ slug: 'city-a', name: 'City A', region: 'Region A', status: 'published' as const }], events: [], guides: [], projects: [], stories: [], useCases: []
    } as unknown as RecordSet;
    
    // Simulate Request B loading its RecordSet
    const rsB = {
      ambassadors: [], builders: [], cities: [{ slug: 'city-b', name: 'City B', region: 'Region B', status: 'published' as const }], events: [], guides: [], projects: [], stories: [], useCases: []
    } as unknown as RecordSet;

    // Helper to simulate the old publicCities module-global selector
    const getCityName = (slug: string) => {
      const rs = records();
      return rs.cities.find(c => c.slug === slug)?.name ?? slug;
    };

    const reqA = async () => {
      __setRecords(rsA);
      // Simulate yielding to event loop
      await new Promise(resolve => setTimeout(resolve, 10));
      // By the time Request A resumes and reads from the global cache, B has overwritten it!
      return getCityName('city-a');
    };

    const reqB = async () => {
      await new Promise(resolve => setTimeout(resolve, 5)); // starts while A is yielded
      __setRecords(rsB); // Overwrites the module-global state!
      return getCityName('city-b');
    };

    const [resA, resB] = await Promise.all([reqA(), reqB()]);

    // Request B succeeds because it just set the global state
    expect(resB).toBe('City B');
    
    // Request A FAILS to get its own data! It gets 'city-a' (fallback) instead of 'City A'
    // because Request B overwrote the global dataset!
    expect(resA).not.toBe('City A');
    expect(resA).toBe('city-a');
  });
});
