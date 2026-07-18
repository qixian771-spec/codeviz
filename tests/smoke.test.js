#!/usr/bin/env node
/**
 * smoke.test.js - CodeViz 零依赖冒烟测试
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseTasksMd, getStats } = require('../src/parser');
const { ProjectManager } = require('../src/project-manager');
const { createProjectPayload } = require('../src/server');

const root = path.resolve(__dirname, '..');
const exampleRoot = path.join(root, 'examples');
const templateIndex = path.join(root, 'templates', 'index.html');
const templateClient = path.join(root, 'templates', 'client.js');

function testExampleParsing() {
  const content = fs.readFileSync(path.join(exampleRoot, 'tasks.md'), 'utf-8');
  const { phases, tasks } = parseTasksMd(content);
  const stats = getStats(tasks);

  assert.strictEqual(phases.length, 6, 'example should contain 6 phases');
  assert.strictEqual(tasks.length, 16, 'example should contain 16 tasks');
  assert.strictEqual(stats.done, 5, 'example should contain 5 done tasks');
  assert.deepStrictEqual(tasks.find(task => task.id === 'T005').depends, ['T003', 'T004']);
}

function testSpecKitListFormat() {
  const content = `# Tasks: Demo

## Phase 1: Setup
- [ ] T001 [P] Create scaffold (files: package.json, src/main.js)
- depends: T000
- [x] T002 - Configure app depends: T001

## Phase 2: UI
- [ ] T003 Build dashboard files: src/App.vue depends: T001, T002
`;

  const { phases, tasks } = parseTasksMd(content);
  assert.strictEqual(phases.length, 2, 'list format should keep phases');
  assert.strictEqual(tasks.length, 3, 'list format should parse tasks');
  assert.strictEqual(tasks[0].id, 'T001');
  assert.strictEqual(tasks[0].parallel, true);
  assert.deepStrictEqual(tasks[0].files, ['package.json', 'src/main.js']);
  assert.strictEqual(tasks[1].status, 'done');
  assert.deepStrictEqual(tasks[1].depends, ['T001']);
  assert.deepStrictEqual(tasks[2].depends, ['T001', 'T002']);
}

async function testProjectPayload() {
  const manager = new ProjectManager();
  const project = manager.addProject(exampleRoot);
  const payload = await createProjectPayload(project, { useGit: false, useFiles: false });

  assert.strictEqual(payload.projectName, 'examples');
  assert.strictEqual(payload.phases.length, 6);
  assert.strictEqual(payload.tasks.length, 16);
  assert.strictEqual(payload.stats.total, 16);
}

function testTemplates() {
  const index = fs.readFileSync(templateIndex, 'utf-8');
  const client = fs.readFileSync(templateClient, 'utf-8');

  assert(index.includes('id="canvas"'), 'index should include canvas');
  assert(index.includes('id="theme-toggle"'), 'index should include theme toggle');
  assert(index.includes('/client.js'), 'index should load client.js');
  assert(client.includes('drawLines()'), 'client should draw SVG flow lines');
  assert(client.includes('applyTheme()'), 'client should support theme switching');
}

async function run() {
  const tests = [testExampleParsing, testSpecKitListFormat, testProjectPayload, testTemplates];
  for (const test of tests) {
    await test();
    console.log(`✓ ${test.name}`);
  }
  console.log('\nCodeViz smoke tests passed.');
}

run();
