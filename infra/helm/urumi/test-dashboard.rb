# Run from repository root: ruby infra/helm/urumi/test-dashboard.rb
require 'yaml'
require 'open3'
require 'json'

def check(value, message)
  raise message unless value
end

%w[local prod].each do |environment|
  out, err, status = Open3.capture3('helm', 'template', 'urumi', 'infra/helm/urumi', '-n', 'urumi',
    '-f', "infra/helm/urumi/values-#{environment}.yaml")
  raise err unless status.success?
  docs = YAML.load_stream(out).compact
  find = ->(kind, name) { docs.find { |d| d['kind'] == kind && d.dig('metadata', 'name') == name } }
  config = find.call('ConfigMap', 'urumi-dashboard-config')
  expected_url = environment == 'local' ? 'http://gateway.localhost/mcp' : 'https://gateway.example.com/mcp'
  check(JSON.parse(config.dig('data', 'runtime-config.json')) == {'publicMcpUrl' => expected_url}, 'Expose only public runtime connection information')
  workload = find.call('Deployment', 'urumi-dashboard')
  check(workload, 'Dashboard workload missing')
  pod = workload.dig('spec', 'template', 'spec')
  check(pod['automountServiceAccountToken'] == false, 'Static server must not get an API token')
  check(pod.dig('securityContext', 'runAsNonRoot') == true, 'Static server must be unprivileged')
  check(workload.dig('spec', 'template', 'metadata', 'annotations', 'checksum/public-config').to_s.size == 64, 'Config change must roll dashboard Pods')
  check(pod['volumes'].any? { |v| v.dig('configMap', 'name') == 'urumi-dashboard-config' }, 'Runtime ConfigMap must be mounted')
  container = pod['containers'][0]
  check(container['volumeMounts'].any? { |v| v['mountPath'] == '/usr/share/nginx/html/runtime-config.json' && v['readOnly'] }, 'Config must be a read-only file')
  %w[startupProbe readinessProbe livenessProbe resources].each { |key| check(container[key], "Missing #{key}") }
  check(container.dig('securityContext', 'readOnlyRootFilesystem') == true, 'Root filesystem must be read-only')
  check(container.dig('securityContext', 'capabilities', 'drop') == ['ALL'], 'Drop capabilities')
  check(!container.key?('env') && !container.key?('envFrom'), 'Static server needs no secrets or environment')
  check(find.call('Service', 'urumi-dashboard').dig('spec', 'type') == 'ClusterIP', 'Dashboard Service must stay internal')
  ingress = find.call('Ingress', 'urumi-dashboard')
  host = environment == 'local' ? 'dashboard.localhost' : 'dashboard.example.com'
  check(ingress.dig('spec', 'rules', 0, 'host') == host, 'Wrong dashboard origin')
  paths = ingress.dig('spec', 'rules', 0, 'http', 'paths')
  check(paths.map { |p| [p['path'], p.dig('backend', 'service', 'name')] }.sort == [['/', 'urumi-dashboard'], ['/api', 'urumi-gateway']], 'Only SPA and management routes belong on dashboard host')
  check(paths.all? { |p| p['pathType'] == 'Prefix' }, 'Management routes and deep links need prefix routing')
  gateway = find.call('Deployment', 'urumi-gateway')
  check(gateway.dig('spec', 'replicas') == 1, 'Runtime registry requires one gateway replica')
  check(gateway.dig('spec', 'strategy', 'type') == 'Recreate', 'Updates must not run two live registries concurrently')
  env = gateway.dig('spec', 'template', 'spec', 'containers', 0, 'env').to_h { |e| [e['name'], e['value']] }
  check(env['MCP_ALLOWED_HOSTS'].split(',').include?(host), 'Gateway must allow dashboard Host header')
  scheme = environment == 'local' ? 'http' : 'https'
  check(env['DASHBOARD_TRUSTED_ORIGINS'] == "#{scheme}://#{host}", 'Trust only the actual dashboard origin')
  check(env['DASHBOARD_ALLOW_HTTP'] == (environment == 'local' ? 'true' : 'false'), 'HTTP must be explicitly local')
  check(env['DASHBOARD_TRUSTED_PROXIES'] == '', 'Never guess proxy IPs')
  if environment == 'prod'
    %w[urumi-dashboard urumi-gateway urumi-wordpress].each do |name|
      check(find.call('Ingress', name).dig('spec', 'tls', 0, 'secretName').to_s.size > 0, "TLS missing for #{name}")
    end
  end
  policy = find.call('NetworkPolicy', 'urumi-dashboard')
  check(policy.dig('spec', 'policyTypes').sort == ['Egress', 'Ingress'], 'Static server needs ingress and egress isolation')
  check(policy.dig('spec', 'egress') == [], 'Static server needs no outbound access')
  check(policy.dig('spec', 'ingress', 0, 'from') == [{'namespaceSelector' => {'matchLabels' => {'kubernetes.io/metadata.name' => 'traefik'}}}], 'Only ingress controller may reach static server')
  check(find.call('Ingress', 'urumi-gateway').dig('spec', 'rules', 0, 'http', 'paths').map { |p| p['path'] } == ['/mcp'], 'Preserve MCP endpoint')
end
[['dashboard.enabled=false', 'urumi-dashboard'], ['ingress.dashboard.enabled=false', 'urumi-dashboard']].each do |override, name|
  out, err, status = Open3.capture3('helm', 'template', 'urumi', 'infra/helm/urumi', '--set', override)
  raise err unless status.success?
  docs = YAML.load_stream(out).compact
  check(docs.none? { |d| d['kind'] == 'Ingress' && d.dig('metadata', 'name') == name }, 'Disabled dashboard ingress must be omitted')
  if override == 'dashboard.enabled=false'
    check(docs.none? { |d| [name, 'urumi-dashboard-config'].include?(d.dig('metadata', 'name')) }, 'Disabled dashboard must omit its resources')
  end
end
%w[gateway.localhost store.localhost].each do |host|
  _, _, status = Open3.capture3('helm', 'template', 'urumi', 'infra/helm/urumi', '--set', "global.dashboardHost=#{host}")
  check(!status.success?, 'Colliding public hosts must be rejected')
end
puts 'Dashboard chart regression checks passed (local and prod)'

['https://user:secret@gateway.test/mcp', 'https://gateway.test/mcp?token=secret',
 'https://gateway.test/mcp#secret', 'ftp://gateway.test/mcp', '/mcp',
 'http://999.999.999.999/mcp', 'http://gateway.123/mcp',
 'https://[1234]/mcp', 'https://[:::]/mcp', 'https://gateway..test/mcp',
 'http://gateway.test:99999/mcp', 'https://gateway.test/other', ' https://gateway.test/mcp'].each do |url|
  _, _, status = Open3.capture3('helm', 'template', 'urumi', 'infra/helm/urumi', '--set-string', "dashboard.publicMcpUrl=#{url}")
  check(!status.success?, 'Invalid public URL must fail chart validation')
end
out, err, status = Open3.capture3('helm', 'template', 'urumi', 'infra/helm/urumi', '--set-string', 'dashboard.publicMcpUrl=')
raise err unless status.success?
config = YAML.load_stream(out).compact.find { |d| d['kind'] == 'ConfigMap' && d.dig('metadata', 'name') == 'urumi-dashboard-config' }
check(JSON.parse(config.dig('data', 'runtime-config.json')) == {'publicMcpUrl' => ''}, 'Missing URL must never infer a destination')
puts 'Runtime public URL chart checks passed'

['http://127.0.0.1:3000/mcp', 'http://localhost:8080/mcp', 'https://[::1]/mcp', 'https://[2001:db8::1]:443/mcp',
 'https://[2001:db8:0:0:0:0:0:1]/mcp'].each do |url|
  _, err, status = Open3.capture3('helm', 'template', 'urumi', 'infra/helm/urumi', '--set-string', "dashboard.publicMcpUrl=#{url}")
  check(status.success?, "Valid public URL rejected: #{err}")
end
