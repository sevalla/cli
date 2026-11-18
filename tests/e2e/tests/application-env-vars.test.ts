import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { sevalla } from '../helpers/cli.ts'
import { safeDeleteApp, safeDelete } from '../helpers/cleanup.ts'

interface Cluster {
  id: string
  [key: string]: unknown
}

interface Project {
  id: string
  [key: string]: unknown
}

interface App {
  id: string
  [key: string]: unknown
}

interface EnvVar {
  id: string
  key?: string
  value?: string
  [key: string]: unknown
}

describe('application environment variables', () => {
  const ts = Date.now()
  let clusterId: string | undefined
  let projectId: string | undefined
  let createdAppId: string | undefined
  let createdProjectId: string | undefined
  let createdEnvVarId: string | undefined

  before(async () => {
    // Validate API key to ensure credentials are working
    const validateRes = await sevalla(['api-keys', 'validate'])
    assert.equal(validateRes.exitCode, 0, `api-keys validate failed: ${validateRes.stderr}`)

    // Get a cluster ID
    const clustersRes = await sevalla(['resources', 'clusters'])
    assert.equal(clustersRes.exitCode, 0, `resources clusters failed: ${clustersRes.stderr}`)
    const clusters = clustersRes.json<Cluster[]>()
    assert.ok(Array.isArray(clusters), 'clusters response should be an array')
    assert.ok(clusters.length > 0, 'at least one cluster must exist')
    clusterId = (clusters[0] as Cluster).id

    // List existing projects; create one if none exist
    const projectsRes = await sevalla(['projects', 'list'])
    assert.equal(projectsRes.exitCode, 0, `projects list failed: ${projectsRes.stderr}`)
    const projects = projectsRes.json<Project[]>()

    if (projects.length > 0) {
      projectId = (projects[0] as Project).id
    } else {
      const createProjectRes = await sevalla([
        'projects',
        'create',
        '--name',
        `e2e-env-vars-project-${ts}`,
      ])
      assert.equal(createProjectRes.exitCode, 0, `projects create failed: ${createProjectRes.stderr}`)
      const project = createProjectRes.json<Project>()
      projectId = project.id
      createdProjectId = project.id
    }

    // Create an application from docker image
    const appName = `e2e-env-vars-app-${ts}`
    const appRes = await sevalla([
      'apps',
      'create',
      '--name',
      appName,
      '--project',
      projectId,
      '--cluster',
      clusterId,
      '--source',
      'dockerImage',
      '--docker-image',
      'nginx:latest',
    ])
    assert.equal(appRes.exitCode, 0, `apps create failed: ${appRes.stderr}`)
    const app = appRes.json<App>()
    assert.ok(app.id, 'created app should have an id')
    createdAppId = app.id
  })

  after(async () => {
    if (createdAppId) {
      await safeDeleteApp(createdAppId)
    }
    if (createdProjectId) {
      await safeDelete(['projects'], createdProjectId)
    }
  })

  it('should create an environment variable', async () => {
    assert.ok(createdAppId, 'createdAppId must be set from before hook')

    const res = await sevalla([
      'apps',
      'env-vars',
      'create',
      createdAppId,
      '--key',
      'E2E_TEST_VAR',
      '--value',
      'test-value-123',
    ])
    assert.equal(res.exitCode, 0, `env-vars create failed: ${res.stderr}`)

    const envVar = res.json<EnvVar>()
    assert.ok(envVar.id, 'created env var should have an id')
    assert.ok(!('value' in envVar), 'create should not echo the value')
    assert.ok(!res.stdout.includes('test-value-123'))
    createdEnvVarId = envVar.id
  })

  it('should list environment variables', async () => {
    assert.ok(createdAppId, 'createdAppId must be set from before hook')
    assert.ok(createdEnvVarId, 'createdEnvVarId must be set from create test')

    const res = await sevalla(['apps', 'env-vars', 'list', '--app-id', createdAppId])
    assert.equal(res.exitCode, 0, `env-vars list failed: ${res.stderr}`)

    const envVars = res.json<EnvVar[]>()
    assert.ok(Array.isArray(envVars), 'response should be an array')

    const found = envVars.find((v) => v.id === createdEnvVarId)
    assert.ok(found, 'created env var should appear in the list')
    assert.ok(!('value' in found), 'values should be hidden by default')
  })

  it('should list environment variable values with --show-values', async () => {
    assert.ok(createdAppId, 'createdAppId must be set from before hook')

    const res = await sevalla(['apps', 'env-vars', 'list', '--app-id', createdAppId, '--show-values'])
    assert.equal(res.exitCode, 0, `env-vars list failed: ${res.stderr}`)
    const found = res.json<EnvVar[]>().find((v) => v.id === createdEnvVarId)
    assert.equal(found?.value, 'test-value-123')
  })

  it('should say on stderr when more pages exist', async () => {
    assert.ok(createdAppId, 'createdAppId must be set from before hook')

    const second = await sevalla([
      'apps', 'env-vars', 'create', createdAppId, '--key', 'E2E_TEST_VAR_2', '--value', 'x',
    ])
    assert.equal(second.exitCode, 0, `env-vars create failed: ${second.stderr}`)

    const res = await sevalla(['apps', 'env-vars', 'list', '--app-id', createdAppId, '--per-page', '1'])
    assert.equal(res.exitCode, 0, `env-vars list failed: ${res.stderr}`)
    assert.equal(res.json<EnvVar[]>().length, 1)
    assert.match(res.stderr, /Showing 1-1 of \d+\. Use --page 2 for the next page\./)
  })

  it('should mask the value in an update dry run', async () => {
    assert.ok(createdAppId, 'createdAppId must be set from before hook')
    assert.ok(createdEnvVarId, 'createdEnvVarId must be set from create test')

    const res = await sevalla([
      'apps', 'env-vars', 'update', createdEnvVarId, '--app-id', createdAppId,
      '--value', 'dry-run-secret', '--dry-run',
    ])
    assert.equal(res.exitCode, 0, `env-vars update --dry-run failed: ${res.stderr}`)
    const body = res.json<{ dry_run: boolean; body: { value: string } }>()
    assert.equal(body.dry_run, true)
    assert.equal(body.body.value, '********')
  })

  it('should update an environment variable', async () => {
    assert.ok(createdAppId, 'createdAppId must be set from before hook')
    assert.ok(createdEnvVarId, 'createdEnvVarId must be set from create test')

    const res = await sevalla([
      'apps',
      'env-vars',
      'update',
      createdEnvVarId,
      '--app-id',
      createdAppId,
      '--value',
      'updated-value-456',
    ])
    assert.equal(res.exitCode, 0, `env-vars update failed: ${res.stderr}`)
    assert.ok(!res.stdout.includes('updated-value-456'), 'update should not echo the value')
  })

  it('should create a secret variable whose value is never returned', async () => {
    assert.ok(createdAppId, 'createdAppId must be set from before hook')

    const res = await sevalla([
      'apps', 'env-vars', 'create', createdAppId, '--key', 'E2E_SECRET_VAR', '--value', 'secret-value-789',
      '--secret', '--runtime', 'true', '--buildtime', 'false',
    ])
    assert.equal(res.exitCode, 0, `env-vars create --secret failed: ${res.stderr}`)
    const created = res.json<EnvVar>()
    assert.equal(created.is_secret, true)
    assert.equal(created.is_runtime, true)
    assert.equal(created.is_buildtime, false)

    const list = await sevalla(['apps', 'env-vars', 'list', '--app-id', createdAppId, '--show-values'])
    assert.equal(list.exitCode, 0, `env-vars list failed: ${list.stderr}`)
    const found = list.json<EnvVar[]>().find((v) => v.id === created.id)
    assert.equal(found?.is_secret, true)
    assert.equal(found?.value, null)
    assert.ok(!list.stdout.includes('secret-value-789'))
  })

  it('should reject a non-boolean --runtime', async () => {
    assert.ok(createdAppId, 'createdAppId must be set from before hook')
    const res = await sevalla([
      'apps', 'env-vars', 'create', createdAppId, '--key', 'E2E_BAD', '--value', 'x', '--runtime', 'yes',
    ])
    assert.equal(res.exitCode, 1)
    assert.match(res.stderr, /--runtime must be true or false/)
  })

  it('should make a regular variable secret and turn off its build-time use', async () => {
    assert.ok(createdAppId, 'createdAppId must be set from before hook')
    assert.ok(createdEnvVarId, 'createdEnvVarId must be set from create test')

    const res = await sevalla([
      'apps', 'env-vars', 'update', createdEnvVarId, '--app-id', createdAppId, '--secret', '--buildtime', 'false',
    ])
    assert.equal(res.exitCode, 0, `env-vars update --secret failed: ${res.stderr}`)
    const updated = res.json<EnvVar>()
    assert.equal(updated.is_secret, true)
    assert.equal(updated.is_buildtime, false)
  })

  it('should create, list and delete a secret global variable', async () => {
    const res = await sevalla([
      'global-env-vars', 'create', '--key', `E2E_GLOBAL_SECRET_${ts}`, '--value', 'global-secret-321', '--secret',
      '--buildtime', 'false',
    ])
    assert.equal(res.exitCode, 0, `global-env-vars create --secret failed: ${res.stderr}`)
    const created = res.json<EnvVar>()
    try {
      assert.equal(created.is_secret, true)
      assert.equal(created.is_buildtime, false)
      const list = await sevalla(['global-env-vars', 'list', '--show-values', '--per-page', '100'])
      assert.equal(list.exitCode, 0, `global-env-vars list failed: ${list.stderr}`)
      // The list is oldest first, so --per-page 100 may not reach a new variable on a busy company
      const found = list.json<EnvVar[]>().find((v) => v.id === created.id)
      if (found) assert.equal(found.value, null)
      assert.ok(!list.stdout.includes('global-secret-321'))

      const update = await sevalla(['global-env-vars', 'update', created.id, '--value', 'replaced', '--secret'])
      assert.equal(update.exitCode, 0, `global-env-vars update --secret failed: ${update.stderr}`)
      assert.equal(update.json<EnvVar>().is_secret, true)
    } finally {
      await safeDelete(['global-env-vars'], created.id)
    }
  })

  it('should delete an environment variable', async () => {
    assert.ok(createdAppId, 'createdAppId must be set from before hook')
    assert.ok(createdEnvVarId, 'createdEnvVarId must be set from create test')

    const res = await sevalla([
      'apps',
      'env-vars',
      'delete',
      createdAppId,
      createdEnvVarId,
      '--confirm',
    ])
    assert.equal(res.exitCode, 0, `env-vars delete failed: ${res.stderr}`)

    // Clear so we know the env var was cleaned up
    createdEnvVarId = undefined
  })
})
