# Run with: ruby infra/helm/urumi/test-secret-rbac.rb
require 'yaml'
require 'open3'

def render(environment, references)
  output, error, status = Open3.capture3('helm', 'template', 'urumi', 'infra/helm/urumi', '-n', 'urumi',
    '-f', "infra/helm/urumi/values-#{environment}.yaml", '--set-json', "gateway.secretReferences=#{references}")
  raise error unless status.success?
  YAML.load_stream(output).compact
end

def check(condition, message)
  raise message unless condition
end

%w[local prod].each do |environment|
  [[], [{ 'namespace' => 'urumi', 'name' => 'approved-token', 'key' => 'token' },
        { 'namespace' => 'urumi', 'name' => 'approved-token', 'key' => 'other' }]].each do |refs|
    require 'json'
    docs = render(environment, refs.to_json)
    sa = docs.select { |d| d['kind'] == 'ServiceAccount' }
    check(sa.size == 1 && sa[0]['metadata'] == { 'name' => 'urumi-gateway', 'namespace' => 'urumi' }, 'Dedicated namespaced gateway ServiceAccount required')
    gateway = docs.find { |d| d['kind'] == 'Deployment' && d.dig('metadata', 'name') == 'urumi-gateway' }
    check(gateway.dig('spec', 'template', 'spec', 'serviceAccountName') == 'urumi-gateway', 'Deployment must bind the gateway ServiceAccount')
    env = gateway.dig('spec', 'template', 'spec', 'containers', 0, 'env').find { |e| e['name'] == 'UPSTREAM_SECRET_REFERENCES' }
    check(JSON.parse(env['value']) == refs, 'Runtime allowlist must match chart references')
    roles = docs.select { |d| %w[Role ClusterRole].include?(d['kind']) }
    bindings = docs.select { |d| %w[RoleBinding ClusterRoleBinding].include?(d['kind']) }
    if refs.empty?
      check(roles.empty? && bindings.empty?, 'Empty approval must grant no Secret access')
    else
      check(roles.size == 1 && roles[0]['kind'] == 'Role', 'Only one namespaced Role permitted')
      check(roles[0]['metadata'] == { 'name' => 'urumi-gateway-secrets', 'namespace' => 'urumi' }, 'Role scope mismatch')
      check(roles[0]['rules'] == [{ 'apiGroups' => [''], 'resources' => ['secrets'], 'resourceNames' => ['approved-token'], 'verbs' => ['get'] }], 'Only get on exact approved names permitted')
      check(bindings.size == 1 && bindings[0]['kind'] == 'RoleBinding', 'Only namespaced binding permitted')
      check(bindings[0]['metadata'] == { 'name' => 'urumi-gateway-secrets', 'namespace' => 'urumi' }, 'Binding scope mismatch')
      check(bindings[0]['roleRef'] == { 'apiGroup' => 'rbac.authorization.k8s.io', 'kind' => 'Role', 'name' => 'urumi-gateway-secrets' }, 'Exact Role reference required')
      check(bindings[0]['subjects'] == [{ 'kind' => 'ServiceAccount', 'name' => 'urumi-gateway', 'namespace' => 'urumi' }], 'Exact ServiceAccount subject required')
    end
  end
end
# Cross-namespace approvals cannot silently grant unusable or broader permissions.
_, _, status = Open3.capture3('helm', 'template', 'urumi', 'infra/helm/urumi', '-n', 'urumi', '--set-json',
  'gateway.secretReferences=[{"namespace":"other","name":"token","key":"token"}]')
check(!status.success?, 'Cross-namespace references must fail rendering')
puts 'Secret RBAC assertions passed for local and production'
