// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useDebouncedPersist } from './use-debounced-persist';
import { DatasetRepository } from '../features/dataset/repository';

/**
 * The ordering guarantee: when the signature changes while a debounced write
 * is pending, the pending write must be skipped and only the newest payload
 * may land. This is what keeps a Reset's delete from losing a race against a
 * pre-Reset write on a slow runner.
 */

let repository: DatasetRepository;
let writes: string[] = [];

function Host({ signature, text }: { signature: string; text: string }) {
  const { markPersisted } = useDebouncedPersist(
    signature,
    async () => {
      writes.push(text);
      // Hold the transaction open so a racing write could otherwise land late.
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
    async () => repository,
    20,
  );
  return <button onClick={() => markPersisted(signature)}>{signature}</button>;
}

describe('useDebouncedPersist ordering', () => {
  it('skips a pending write whose signature was superseded', async () => {
    repository = await DatasetRepository.open();
    writes = [];
    const { rerender } = render(<Host signature="v1" text="old-payload" />);
    // Let the v1 timer fire and its (slow) write start.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(writes).toEqual(['old-payload']);

    // Change the signature while nothing is pending, then change it again
    // quickly: the first of the two new payloads must never reach the writer.
    rerender(<Host signature="v2" text="intermediate" />);
    rerender(<Host signature="v3" text="new-payload" />);
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(writes).toEqual(['old-payload', 'new-payload']);
  });

  it('a seed set before the first effect keeps the initial payload unwritten', async () => {
    // This is exactly how the restore path uses the seed: the marker goes in
    // before the writer's effect ever runs, so a freshly restored record is
    // not immediately rewritten with a fresh updatedAt.
    repository = await DatasetRepository.open();
    writes = [];
    function Seeded() {
      const { markPersisted } = useDebouncedPersist(
        'restored',
        async () => {
          writes.push('restored');
        },
        async () => repository,
        20,
      );
      // Seed during render, before effects flush.
      markPersisted('restored');
      return null;
    }
    render(<Seeded />);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(writes).toEqual([]);

    // A real change still writes: a new signature schedules normally.
    function Seeded2() {
      const { markPersisted } = useDebouncedPersist(
        'changed',
        async () => {
          writes.push('changed');
        },
        async () => repository,
        20,
      );
      markPersisted('restored');
      return null;
    }
    render(<Seeded2 />);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(writes).toEqual(['changed']);
  });

  it('retries after a failed write on the next signature change', async () => {
    repository = await DatasetRepository.open();
    writes = [];
    let shouldFail = true;
    function Failing({ signature, text }: { signature: string; text: string }) {
      useDebouncedPersist(
        signature,
        async () => {
          if (shouldFail) throw new Error('storage full');
          writes.push(text);
        },
        async () => repository,
        20,
      );
      return null;
    }
    const { rerender } = render(<Failing signature="a" text="a" />);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(writes).toEqual([]);
    // The failed write must not count as persisted: a real change writes both
    // payloads' latest state.
    shouldFail = false;
    rerender(<Failing signature="b" text="b" />);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(writes).toEqual(['b']);
  });
});
