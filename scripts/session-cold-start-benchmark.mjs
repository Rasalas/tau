import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = fileURLToPath(new URL('..', import.meta.url));
const rounded = value => Math.round(value * 10) / 10;
if (process.argv[2] === '--child') {
  const { CodexSessionStore } = await import(pathToFileURL(process.argv[3]));
  const store = new CodexSessionStore({ filePath: process.argv[4] });
  const initialRss = process.memoryUsage().rss;
  let start = performance.now();
  const metadata = await store.listMetadata();
  const coldMetadataMs = performance.now() - start;
  global.gc?.();
  const metadataRssMiB = (process.memoryUsage().rss - initialRss) / 1048576;
  start = performance.now();
  const selected = await store.get('thread-0');
  const selectedOpenMs = performance.now() - start;
  global.gc?.();
  const selectedRssMiB = (process.memoryUsage().rss - initialRss) / 1048576;
  start = performance.now();
  await store.setTitle('thread-0', root, 'first write', 'renamed');
  const firstWriteMs = performance.now() - start;
  // Validate after measuring: constructing expected strings must not inflate
  // the selected-open timing or retained RSS, especially for the long thread.
  assert.equal(metadata.length, Number(process.argv[5]));
  assert.ok(metadata.every(record => record.messageCount === Number(process.argv[6])));
  assert.equal(selected.messages.length, Number(process.argv[6]));
  assert.ok(selected.messages.every((message, j) => message.text === `0:${j} ${'x'.repeat(1024)}`));
  await store.dispose();
  console.log(JSON.stringify({ threads: metadata.length, selectedMessages: selected.messages.length, coldMetadataMs: rounded(coldMetadataMs), selectedOpenMs: rounded(selectedOpenMs), metadataRssMiB: rounded(metadataRssMiB), selectedRssMiB: rounded(selectedRssMiB), firstWriteMs: rounded(firstWriteMs) }));
} else {
  await mkdir(join(root, '.scratch/lazy-sqlite-hydration'), { recursive: true });
  const directory = await mkdtemp(join(root, '.scratch/lazy-sqlite-hydration/benchmark-'));
  try {
    const bundle = join(directory, 'store.mjs');
    await build({ entryPoints: [join(root, 'kits/codex/session-store.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external', alias: { 'tau/host-extension': join(root, 'src/main/host-extension-api.ts') } });
    const { CodexSessionStore } = await import(pathToFileURL(bundle));
    const results = [];
    for (const [threads, messages] of [[10, 200], [100, 200], [1000, 200], [1, 20000]]) {
      const filePath = join(directory, `${threads}-${messages}.json`);
      await writeFile(filePath, JSON.stringify({ version: 1, sessions: Array.from({ length: threads }, (_, i) => ({ tauThreadId: `thread-${i}`, cwd: root, updatedAt: i + 1, messages: Array.from({ length: messages }, (_message, j) => ({ role: j % 2 ? 'assistant' : 'user', text: `${i}:${j} ${'x'.repeat(1024)}`, timestamp: j + 1 })) })) }));
      const migration = new CodexSessionStore({ filePath });
      await migration.listMetadata();
      await migration.dispose();
      // SQL views throw if payload is selected: first forbid every message
      // read, then allow only thread-0. This asserts structure without a clock.
      const audit = new DatabaseSync(migration.databasePath);
      try {
        audit.exec(`ALTER TABLE messages RENAME TO benchmark_messages;
          CREATE VIEW messages AS SELECT thread_id, ordinal, json('forbidden payload read') AS payload FROM benchmark_messages`);
        const cold = new CodexSessionStore({ filePath });
        try {
          const catalog = await cold.listMetadata();
          assert.equal(catalog.length, threads);
          assert.ok(catalog.every(record => record.messageCount === messages));
          audit.exec(`DROP VIEW messages;
            CREATE VIEW messages AS SELECT thread_id, ordinal,
              CASE WHEN thread_id='thread-0' THEN payload ELSE json('unselected payload read') END AS payload FROM benchmark_messages`);
          const selected = await cold.get('thread-0');
          assert.equal(selected.messages.length, messages);
          assert.ok(selected.messages.every((message, j) => message.text === `0:${j} ${'x'.repeat(1024)}`));
        } finally { await cold.dispose(); }
      } finally {
        audit.exec('DROP VIEW messages; ALTER TABLE benchmark_messages RENAME TO messages');
        audit.close();
      }
      const samples = [];
      for (let repeat = 0; repeat < 3; repeat++) {
        const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--child', bundle, filePath, String(threads), String(messages)], { encoding: 'utf8' });
        if (child.status !== 0) throw new Error(child.stderr);
        samples.push(JSON.parse(child.stdout.trim()));
      }
      results.push({ threads, messagesPerThread: messages, metadataMessagePayloadReads: 0, selectedThreadOnly: true, samples });
      console.log(JSON.stringify(results.at(-1)));
    }
    const report = { generatedAt: new Date().toISOString(), fixture: '200 messages/thread, 1 KiB text; separate Node process/sample; 3 samples; warm filesystem cache; RSS delta after GC', results };
    const output = process.argv[2] ?? join(root, '.scratch/lazy-sqlite-hydration/cold-start-report.json');
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(`Report: ${output}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
