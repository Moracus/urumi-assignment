# Run from repository root: ruby infra/helm/urumi/test-mongodb.rb
require 'yaml'
require 'json'
require 'open3'

def render(environment, managed)
  out, err, status = Open3.capture3('helm', 'template', 'urumi', 'infra/helm/urumi', '-n', 'urumi',
    '-f', "infra/helm/urumi/values-#{environment}.yaml", '--set-json', "mongodb.enabled=#{managed}")
  raise err unless status.success?
  YAML.load_stream(out).compact
end

def check(value, message)
  raise message unless value
end

%w[local prod].each do |environment|
  external = render(environment, false)
  docs = render(environment, true)
  mongo = docs.find { |d| d['kind'] == 'StatefulSet' && d.dig('metadata', 'name') == 'urumi-mongodb' }
  check(mongo, 'Managed MongoDB requires a StatefulSet')
  check(mongo.dig('spec', 'replicas') == 1, 'Single-node replica set only')
  check(mongo.dig('spec', 'volumeClaimTemplates', 0, 'spec', 'accessModes') == ['ReadWriteOnce'], 'Persistent storage required')
  check(mongo.dig('spec', 'persistentVolumeClaimRetentionPolicy') == {'whenDeleted' => 'Retain', 'whenScaled' => 'Retain'}, 'Claims must survive deletion and scale-down')
  check(mongo.dig('spec', 'template', 'spec', 'automountServiceAccountToken') == false, 'Database requires no Kubernetes API token')
  container = mongo.dig('spec', 'template', 'spec', 'containers', 0)
  %w[startupProbe readinessProbe livenessProbe resources].each { |key| check(container[key], "Missing #{key}") }
  credentials = container['env'].select { |e| e['name'].start_with?('MONGO_INITDB_ROOT_') }
  check(credentials.size == 2 && credentials.all? { |e| e.dig('valueFrom', 'secretKeyRef', 'name') == 'urumi-mongodb-auth' && !e.key?('value') }, 'Credentials must use Secrets')
  check(container['args'].include?('--auth') && container['args'].include?('--keyFile') && container['args'].include?('--replSet'), 'Database and replica membership authentication required')
  secret_volume = mongo.dig('spec', 'template', 'spec', 'volumes').find { |v| v['name'] == 'auth' }
  check(secret_volume['secret'] == {'secretName' => 'urumi-mongodb-auth', 'items' => [{'key' => 'keyfile', 'path' => 'keyfile'}]}, 'Membership key must come from Secret')
  service = docs.find { |d| d['kind'] == 'Service' && d.dig('metadata', 'name') == 'urumi-mongodb' }
  check(service.dig('spec', 'clusterIP') == 'None', 'Stable internal replica-set DNS required')
  check(docs.none? { |d| d['kind'] == 'Secret' }, 'Chart must not generate credentials')
  ingress = docs.select { |d| d['kind'] == 'Ingress' }.to_json
  check(!ingress.include?('urumi-mongodb'), 'MongoDB must remain private')
  policy = docs.find { |d| d['kind'] == 'NetworkPolicy' && d.dig('metadata', 'name') == 'urumi-mongodb' }
  check(policy.dig('spec', 'ingress') == [{'from' => [{'podSelector' => {'matchLabels' => {'app' => 'urumi-gateway'}}}], 'ports' => [{'protocol' => 'TCP', 'port' => 27017}]}], 'Only gateway database ingress allowed')
  egress = docs.find { |d| d.dig('metadata', 'name') == 'urumi-gateway-egress' }.dig('spec', 'egress')
  check(egress.include?({'to' => [{'podSelector' => {'matchLabels' => {'app' => 'urumi-mongodb'}}}], 'ports' => [{'protocol' => 'TCP', 'port' => 27017}]}), 'Managed database needs narrow gateway egress')
  gateway = docs.find { |d| d['kind'] == 'Deployment' && d.dig('metadata', 'name') == 'urumi-gateway' }
  uri = gateway.dig('spec', 'template', 'spec', 'containers', 0, 'env').find { |e| e['name'] == 'MONGODB_URI' }
  check(uri['valueFrom'] == {'secretKeyRef' => {'name' => 'urumi-identity-storage', 'key' => 'uri'}}, 'URI contract must remain Secret-backed')
  check(external.none? { |d| d.dig('metadata', 'name') == 'urumi-mongodb' }, 'External mode must not provision MongoDB')
  %w[urumi-wordpress-pvc urumi-mariadb-pvc urumi-wordpress urumi-mariadb].each do |name|
    check(docs.select { |d| d.dig('metadata', 'name') == name } == external.select { |d| d.dig('metadata', 'name') == name }, "Existing storage/workloads changed: #{name}")
  end
end
['mongodb.password=unsafe', 'mongodb.enabled=invalid', 'mongodb.authSecretName='].each do |override|
  _, _, status = Open3.capture3('helm', 'template', 'urumi', 'infra/helm/urumi', '--set', override)
  check(!status.success?, 'Invalid settings or credential values must be rejected by schema')
end
puts 'MongoDB chart regression checks passed (local and prod, managed and external)'
