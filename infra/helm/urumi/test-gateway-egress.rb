# Run from the repository root: ruby infra/helm/urumi/test-gateway-egress.rb
require 'yaml'
require 'json'
require 'open3'

def render(environment, overrides = {})
  args = overrides.flat_map { |key, value| ['--set-json', "#{key}=#{value.to_json}"] }
  out, err, status = Open3.capture3('helm', 'template', 'urumi', 'infra/helm/urumi', '-n', 'urumi',
    '-f', "infra/helm/urumi/values-#{environment}.yaml", *args)
  raise err unless status.success?
  YAML.load_stream(out).compact
end

def check(condition, message)
  raise message unless condition
end

%w[local prod].each do |environment|
  docs = render(environment)
  policy = docs.find { |d| d.dig('metadata', 'name') == 'urumi-gateway-egress' }
  check(policy && policy['kind'] == 'NetworkPolicy', 'Gateway egress isolation required')
  check(policy.dig('spec', 'podSelector') == {'matchLabels' => {'app' => 'urumi-gateway'}}, 'Gateway selector mismatch')
  check(policy.dig('spec', 'policyTypes') == ['Egress'], 'Egress policy required')
  rules = policy.dig('spec', 'egress')
  check(rules.size == 4, 'Defaults permit only DNS and three upstreams')
  check(rules[0] == {
    'to' => [{'namespaceSelector' => {'matchLabels' => {'kubernetes.io/metadata.name' => 'kube-system'}},
              'podSelector' => {'matchLabels' => {'k8s-app' => 'kube-dns'}}}],
    'ports' => [{'protocol' => 'UDP', 'port' => 53}, {'protocol' => 'TCP', 'port' => 53}]
  }, 'DNS must restrict namespace, workload and protocols')
  expected = {'urumi-calculator-mcp' => 3002, 'urumi-time-mcp' => 3003, 'urumi-woocommerce-mcp' => 3001}
  actual = rules.drop(1).to_h do |rule|
    check(rule['to'].size == 1, 'Each upstream needs one same-namespace peer')
    [rule.dig('to', 0, 'podSelector', 'matchLabels', 'app'), rule.dig('ports', 0, 'port')]
  end
  check(actual == expected, 'Established upstream names and ports required')
  check(rules.drop(1).all? { |r| r['ports'].size == 1 && r['ports'][0]['protocol'] == 'TCP' }, 'Only upstream TCP ports allowed')

  configured = render(environment, {
    'networkPolicy.gatewayEgress.mongodb' => [{'namespace' => 'data', 'podLabels' => {'app' => 'identity-mongo'}, 'ports' => [27017]}],
    'networkPolicy.gatewayEgress.kubernetesApi' => [{'cidr' => '10.96.0.1/32', 'ports' => [443]}, {'cidr' => '172.19.0.2/32', 'ports' => [6443]}],
    'networkPolicy.gatewayEgress.additionalDestinations' => [{'namespace' => 'tools', 'podLabels' => {'app' => 'approved'}, 'ports' => [8443]}],
    'networkPolicy.gatewayEgress.dns.serviceCidrs' => ['10.96.0.10/32']
  })
  configured_rules = configured.find { |d| d.dig('metadata', 'name') == 'urumi-gateway-egress' }.dig('spec', 'egress')
  check(configured_rules.size == 8, 'Configured destinations must be rendered')
  check(configured_rules[0]['to'].last == {'ipBlock' => {'cidr' => '10.96.0.10/32'}}, 'DNS VIP must be exact')
  check(configured_rules[4] == {'to' => [{'namespaceSelector' => {'matchLabels' => {'kubernetes.io/metadata.name' => 'data'}}, 'podSelector' => {'matchLabels' => {'app' => 'identity-mongo'}}}], 'ports' => [{'protocol' => 'TCP', 'port' => 27017}]}, 'MongoDB namespace and labels must be ANDed')
  check(configured_rules[5..6] == [
    {'to' => [{'ipBlock' => {'cidr' => '10.96.0.1/32'}}], 'ports' => [{'protocol' => 'TCP', 'port' => 443}]},
    {'to' => [{'ipBlock' => {'cidr' => '172.19.0.2/32'}}], 'ports' => [{'protocol' => 'TCP', 'port' => 6443}]}
  ], 'API rules must pin IPs and ports')
  check(configured_rules[7] == {'to' => [{'namespaceSelector' => {'matchLabels' => {'kubernetes.io/metadata.name' => 'tools'}}, 'podSelector' => {'matchLabels' => {'app' => 'approved'}}}], 'ports' => [{'protocol' => 'TCP', 'port' => 8443}]}, 'Additional destination must remain narrow')
  gateway = configured.find { |d| d['kind'] == 'Deployment' && d.dig('metadata', 'name') == 'urumi-gateway' }
  check(gateway.dig('spec', 'replicas') == 1, 'Registry requires one gateway replica')
  env = gateway.dig('spec', 'template', 'spec', 'containers', 0, 'env')
  denied = env.find { |e| e['name'] == 'UPSTREAM_DENIED_CIDRS' }
  check(JSON.parse(denied['value']) == ['10.96.0.1/32', '172.19.0.2/32'], 'API Service and backend addresses must be denied to upstream transport')
  # Only the API hard denials may alter the Deployment.
  default_gateway = docs.find { |d| d['kind'] == 'Deployment' && d.dig('metadata', 'name') == 'urumi-gateway' }
  denied['value'] = default_gateway.dig('spec', 'template', 'spec', 'containers', 0, 'env').find { |e| e['name'] == 'UPSTREAM_DENIED_CIDRS' }['value']
  # Adding approvals must change no exposure, ingress, deployments or storage.
  unaffected = ->(list) { list.reject { |d| d.dig('metadata', 'name') == 'urumi-gateway-egress' } }
  check(unaffected.call(docs) == unaffected.call(configured), 'Egress configuration must not alter other resources')
  services = docs.select { |d| d['kind'] == 'Service' }
  check(services.size == 6 && services.all? { |d| d.dig('spec', 'type') == 'ClusterIP' }, 'All services must remain internal')
  check(docs.select { |d| d['kind'] == 'Ingress' }.map { |d| d.dig('metadata', 'name') }.sort == ['urumi-gateway', 'urumi-wordpress'], 'Only existing public Ingress resources allowed')
  check(docs.select { |d| d['kind'] == 'PersistentVolumeClaim' }.map { |d| d.dig('metadata', 'name') }.sort == ['urumi-mariadb-pvc', 'urumi-wordpress-pvc'], 'Persistent volumes must remain')
  check(render(environment, {'gateway.enabled' => false}).none? { |d| d.dig('metadata', 'name') == 'urumi-gateway-egress' }, 'Disabled gateway must omit policy')
  check(render(environment, {'networkPolicy.enabled' => false}).none? { |d| d['kind'] == 'NetworkPolicy' }, 'Explicit operator opt-out must still work')
end

[{'cidr' => '0.0.0.0/0', 'ports' => [443]}, {'cidr' => '999.1.1.1/32', 'ports' => [443]}, {'cidr' => '::::/128', 'ports' => [443]}, {'namespace' => 'data', 'podLabels' => {}, 'ports' => [27017]},
 {'namespace' => '', 'podLabels' => {'app' => 'mongo'}, 'ports' => [27017]}, {'cidr' => '10.0.0.1/32', 'ports' => []},
 {'cidr' => '10.0.0.1/32', 'ports' => [0]}, {'cidr' => '10.0.0.1/32', 'ports' => [65536]},
 {'cidr' => '10.0.0.1/32', 'ports' => [443], 'unexpected' => true}].each do |invalid|
  _, _, status = Open3.capture3('helm', 'template', 'urumi', 'infra/helm/urumi', '--set-json',
    "networkPolicy.gatewayEgress.additionalDestinations=#{[invalid].to_json}")
  check(!status.success?, 'Broad or malformed destination must fail rendering')
end
puts 'Gateway egress assertions passed for local and production'
