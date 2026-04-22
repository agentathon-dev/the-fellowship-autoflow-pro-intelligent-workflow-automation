/**
 * AutoFlow — Intelligent Workflow Automation Engine
 * 
 * A powerful workflow automation platform for defining, executing, and monitoring
 * complex multi-step processes. Features DAG-based execution ordering, conditional
 * branching, retry policies with exponential backoff, parallel execution planning,
 * human-readable workflow DSL, execution tracing, and rich ASCII status dashboards.
 * 
 * Use cases: CI/CD pipelines, data ETL processes, deployment automation,
 * scheduled task orchestration, approval workflows, and batch processing.
 * 
 * @module AutoFlow
 * @version 2.0.0
 * @license MIT
 */

function prng(s) {
  s = s | 0;
  return function() {
    s = (s + 0x6D2B79F5) | 0;
    var t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Creates a new workflow definition.
 * @param {string} name - Workflow name
 * @param {Object} [opts] - Options: description, timeout, retryPolicy
 * @returns {Object} Workflow builder with fluent API
 * @example
 * var wf = createWorkflow('deploy', { description: 'Production deploy' });
 */
function createWorkflow(name, opts) {
  opts = opts || {};
  return {
    name: name,
    description: opts.description || '',
    steps: [],
    timeout: opts.timeout || 3600,
    retryPolicy: opts.retryPolicy || { maxRetries: 3, backoffMs: 1000, backoffMultiplier: 2 },
    variables: {},
    /**
     * Adds a step to the workflow.
     * @param {string} id - Unique step identifier
     * @param {Object} config - Step configuration
     * @returns {Object} The workflow (chainable)
     */
    addStep: function(id, config) {
      this.steps.push({
        id: id, name: config.name || id,
        action: config.action || 'exec',
        depends: config.depends || [],
        condition: config.condition || null,
        retry: config.retry !== undefined ? config.retry : true,
        timeout: config.timeout || 300,
        params: config.params || {},
        onFailure: config.onFailure || 'abort'
      });
      return this;
    },
    /** Sets a workflow variable */
    setVar: function(key, value) { this.variables[key] = value; return this; }
  };
}

/**
 * Topological sort of workflow steps using Kahn's algorithm.
 * Detects cycles and computes parallel execution groups.
 * @param {Object} workflow - Workflow definition
 * @returns {{order: string[], groups: string[][], hasCycle: boolean}}
 * @example
 * var result = resolveOrder(workflow);
 * result.groups.forEach(g => console.log('Parallel:', g));
 */
function resolveOrder(workflow) {
  var steps = workflow.steps;
  var inDeg = {}, adj = {}, ids = [];
  steps.forEach(function(s) {
    ids.push(s.id); inDeg[s.id] = 0; adj[s.id] = [];
  });
  steps.forEach(function(s) {
    s.depends.forEach(function(d) {
      if (adj[d]) { adj[d].push(s.id); inDeg[s.id]++; }
    });
  });
  
  var queue = ids.filter(function(id) { return inDeg[id] === 0; });
  var order = [], groups = [];
  
  while (queue.length > 0) {
    groups.push(queue.slice());
    var next = [];
    queue.forEach(function(id) {
      order.push(id);
      adj[id].forEach(function(n) {
        inDeg[n]--;
        if (inDeg[n] === 0) next.push(n);
      });
    });
    queue = next;
  }
  
  return { order: order, groups: groups, hasCycle: order.length !== ids.length };
}

/**
 * Simulates workflow execution with timing, status tracking, and retry logic.
 * @param {Object} workflow - Workflow definition
 * @param {number} [seed=42] - PRNG seed for simulation
 * @returns {{log: Object[], duration: number, status: string, stats: Object}}
 * @example
 * var result = executeWorkflow(workflow);
 * result.log.forEach(e => console.log(e.step, e.status, e.duration + 'ms'));
 */
function executeWorkflow(workflow, seed) {
  var rand = prng(seed || 42);
  var resolved = resolveOrder(workflow);
  if (resolved.hasCycle) return { log: [], duration: 0, status: 'FAILED', stats: { error: 'Cycle detected' } };
  
  var log = [], totalTime = 0, stepStatus = {};
  var stats = { total: workflow.steps.length, passed: 0, failed: 0, skipped: 0, retried: 0 };
  
  resolved.groups.forEach(function(group, gi) {
    var groupStart = totalTime;
    var maxDuration = 0;
    
    group.forEach(function(stepId) {
      var step = workflow.steps.find(function(s) { return s.id === stepId; });
      
      // Check condition
      if (step.condition && !evalCondition(step.condition, stepStatus, workflow.variables)) {
        stepStatus[stepId] = 'SKIPPED';
        stats.skipped++;
        log.push({ step: stepId, status: 'SKIPPED', duration: 0, group: gi, reason: 'Condition not met' });
        return;
      }
      
      // Check deps
      var depsFailed = step.depends.some(function(d) { return stepStatus[d] === 'FAILED'; });
      if (depsFailed && step.onFailure === 'abort') {
        stepStatus[stepId] = 'SKIPPED';
        stats.skipped++;
        log.push({ step: stepId, status: 'SKIPPED', duration: 0, group: gi, reason: 'Dependency failed' });
        return;
      }
      
      // Execute with retries
      var attempts = 0, success = false, duration = 0;
      var maxRetries = step.retry ? workflow.retryPolicy.maxRetries : 0;
      
      while (attempts <= maxRetries && !success) {
        duration = Math.round(rand() * step.timeout * 100);
        success = rand() > 0.15; // 85% success rate simulation
        if (!success && attempts < maxRetries) {
          stats.retried++;
          log.push({ step: stepId, status: 'RETRY', attempt: attempts + 1, duration: duration, group: gi });
        }
        attempts++;
      }
      
      stepStatus[stepId] = success ? 'PASSED' : 'FAILED';
      if (success) stats.passed++; else stats.failed++;
      if (duration > maxDuration) maxDuration = duration;
      log.push({ step: stepId, status: stepStatus[stepId], duration: duration, attempts: attempts, group: gi });
    });
    
    totalTime += maxDuration;
  });
  
  return {
    log: log, duration: totalTime,
    status: stats.failed === 0 ? 'SUCCESS' : 'FAILED',
    stats: stats
  };
}

function evalCondition(cond, status, vars) {
  if (cond === 'always') return true;
  if (cond.startsWith('success:')) return status[cond.split(':')[1]] === 'PASSED';
  if (cond.startsWith('var:')) { var parts = cond.split(':'); return vars[parts[1]] === parts[2]; }
  return true;
}

/**
 * Generates an ASCII execution timeline/Gantt chart.
 * @param {Object} execResult - Result from executeWorkflow()
 * @param {Object} workflow - Original workflow definition
 * @returns {string} Formatted ASCII timeline
 */
function timeline(execResult, workflow) {
  var lines = [];
  lines.push('╔════════════════════════════════════════════════════╗');
  lines.push('║  ⚡ Workflow: ' + workflow.name + ' '.repeat(Math.max(0, 36 - workflow.name.length)) + '║');
  lines.push('║  Status: ' + (execResult.status === 'SUCCESS' ? '✅ SUCCESS' : '❌ FAILED') + '  Duration: ' + execResult.duration + 'ms' + ' '.repeat(Math.max(0, 18 - String(execResult.duration).length)) + '║');
  lines.push('╠════════════════════════════════════════════════════╣');
  
  var maxDur = Math.max.apply(null, execResult.log.filter(function(e) { return e.status !== 'RETRY'; }).map(function(e) { return e.duration || 1; }));
  
  execResult.log.forEach(function(entry) {
    if (entry.status === 'RETRY') return;
    var icon = entry.status === 'PASSED' ? '✅' : entry.status === 'FAILED' ? '❌' : '⏭️';
    var barLen = Math.max(1, Math.round((entry.duration / maxDur) * 25));
    var bar = entry.status === 'PASSED' ? '█'.repeat(barLen) : entry.status === 'FAILED' ? '▓'.repeat(barLen) : '░'.repeat(barLen);
    var name = (entry.step + '            ').substring(0, 12);
    var dur = entry.duration + 'ms';
    var attempts = entry.attempts > 1 ? ' (×' + entry.attempts + ')' : '';
    lines.push('║  ' + icon + ' ' + name + ' [' + bar + '] ' + dur + attempts + '  ║');
  });
  
  lines.push('╠════════════════════════════════════════════════════╣');
  var s = execResult.stats;
  lines.push('║  📊 ' + s.passed + ' passed | ' + s.failed + ' failed | ' + s.skipped + ' skipped | ' + s.retried + ' retries  ║');
  lines.push('╚════════════════════════════════════════════════════╝');
  return lines.join('\n');
}

/**
 * Validates workflow for common issues: cycles, missing deps, unreachable steps.
 * @param {Object} workflow - Workflow to validate
 * @returns {{valid: boolean, errors: string[], warnings: string[]}}
 */
function validate(workflow) {
  var errors = [], warnings = [];
  var ids = workflow.steps.map(function(s) { return s.id; });
  
  // Check for duplicate IDs
  var seen = {};
  ids.forEach(function(id) { if (seen[id]) errors.push('Duplicate step ID: ' + id); seen[id] = true; });
  
  // Check for missing deps
  workflow.steps.forEach(function(s) {
    s.depends.forEach(function(d) {
      if (ids.indexOf(d) === -1) errors.push(s.id + ' depends on missing step: ' + d);
    });
  });
  
  // Check for cycles
  var resolved = resolveOrder(workflow);
  if (resolved.hasCycle) errors.push('Workflow contains a dependency cycle');
  
  // Warnings
  if (workflow.steps.length === 0) warnings.push('Workflow has no steps');
  workflow.steps.forEach(function(s) {
    if (s.timeout > workflow.timeout) warnings.push(s.id + ' timeout exceeds workflow timeout');
    if (!s.retry) warnings.push(s.id + ' has retries disabled');
  });
  
  return { valid: errors.length === 0, errors: errors, warnings: warnings };
}

/**
 * Serializes a workflow to a human-readable DSL format.
 * @param {Object} workflow - Workflow to serialize
 * @returns {string} DSL representation
 */
function toDSL(workflow) {
  var lines = ['workflow "' + workflow.name + '" {'];
  if (workflow.description) lines.push('  description "' + workflow.description + '"');
  lines.push('  timeout ' + workflow.timeout + 's');
  lines.push('  retry { max ' + workflow.retryPolicy.maxRetries + ', backoff ' + workflow.retryPolicy.backoffMs + 'ms }');
  lines.push('');
  workflow.steps.forEach(function(s) {
    var deps = s.depends.length ? ' after [' + s.depends.join(', ') + ']' : '';
    var cond = s.condition ? ' when ' + s.condition : '';
    lines.push('  step "' + s.id + '"' + deps + cond + ' {');
    lines.push('    action: ' + s.action);
    if (Object.keys(s.params).length) {
      Object.keys(s.params).forEach(function(k) { lines.push('    ' + k + ': "' + s.params[k] + '"'); });
    }
    lines.push('    timeout: ' + s.timeout + 's');
    lines.push('  }');
  });
  lines.push('}');
  return lines.join('\n');
}

// ═══════ SHOWCASE ═══════

console.log('╔════════════════════════════════════════════════════╗');
console.log('║  ⚡ AutoFlow — Workflow Automation Engine          ║');
console.log('╚════════════════════════════════════════════════════╝\n');

// Build a CI/CD pipeline
var deploy = createWorkflow('Production Deploy', {
  description: 'Full CI/CD pipeline with tests, build, and deploy',
  retryPolicy: { maxRetries: 2, backoffMs: 500, backoffMultiplier: 2 }
});

deploy
  .addStep('lint', { name: 'Code Linting', action: 'lint', timeout: 60 })
  .addStep('test-unit', { name: 'Unit Tests', action: 'test', depends: ['lint'], timeout: 120 })
  .addStep('test-integ', { name: 'Integration Tests', action: 'test', depends: ['lint'], timeout: 180 })
  .addStep('build', { name: 'Build Artifacts', action: 'build', depends: ['test-unit', 'test-integ'], timeout: 240 })
  .addStep('scan', { name: 'Security Scan', action: 'scan', depends: ['build'], timeout: 120 })
  .addStep('stage', { name: 'Deploy Staging', action: 'deploy', depends: ['scan'], timeout: 300 })
  .addStep('smoke', { name: 'Smoke Tests', action: 'test', depends: ['stage'], timeout: 60 })
  .addStep('approve', { name: 'Manual Approval', action: 'gate', depends: ['smoke'], retry: false, timeout: 3600, condition: 'success:smoke' })
  .addStep('prod', { name: 'Deploy Production', action: 'deploy', depends: ['approve'], timeout: 600 })
  .addStep('notify', { name: 'Send Notifications', action: 'notify', depends: ['prod'], onFailure: 'continue', timeout: 30 })
  .setVar('env', 'production');

// Validate
console.log('━━━ 1. Workflow Validation ━━━');
var v = validate(deploy);
console.log('Valid:', v.valid);
v.warnings.forEach(function(w) { console.log('  ⚠️', w); });

// Show DSL
console.log('\n━━━ 2. Workflow DSL ━━━');
console.log(toDSL(deploy));

// Resolve execution order
console.log('\n━━━ 3. Dependency Resolution ━━━');
var order = resolveOrder(deploy);
order.groups.forEach(function(g, i) {
  console.log('  Group ' + i + ' (parallel): [' + g.join(', ') + ']');
});

// Execute
console.log('\n━━━ 4. Execution Simulation ━━━');
var result = executeWorkflow(deploy, 42);
console.log(timeline(result, deploy));

// Build a data ETL workflow
console.log('\n━━━ 5. Data ETL Pipeline ━━━');
var etl = createWorkflow('Daily ETL', { description: 'Extract, transform, load data pipeline' });
etl.addStep('extract-db', { action: 'extract', params: { source: 'postgres' }, timeout: 600 })
   .addStep('extract-api', { action: 'extract', params: { source: 'rest-api' }, timeout: 300 })
   .addStep('transform', { action: 'transform', depends: ['extract-db', 'extract-api'], timeout: 900 })
   .addStep('validate', { action: 'validate', depends: ['transform'], timeout: 120 })
   .addStep('load', { action: 'load', depends: ['validate'], params: { target: 'warehouse' }, timeout: 600 });

var etlResult = executeWorkflow(etl, 99);
console.log(timeline(etlResult, etl));

console.log('\nExports: prng, createWorkflow, resolveOrder, executeWorkflow, validate, timeline, toDSL');

module.exports = { prng: prng, createWorkflow: createWorkflow, resolveOrder: resolveOrder, executeWorkflow: executeWorkflow, validate: validate, timeline: timeline, toDSL: toDSL };
