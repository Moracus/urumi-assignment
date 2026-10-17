# Run from the repository root: ruby infra/helm/urumi/test-chat.rb
require 'yaml'
require 'json'
require 'open3'

def render(environment, overrides = {}, valid: true)
  args = overrides.flat_map { |key, value| ['--set-json', "#{key}=#{value.to_json}"] }
  out, err, status = Open3.capture3('helm', 'template', 'urumi', 'infra/helm/urumi', '-n', 'urumi',
    '-f', "infra/helm/urumi/values-#{environment}.yaml", *args)
  raise "Unexpected rendering result: #{err}" unless status.success? == valid
  YAML.load_stream(out).compact if valid
end

def check(condition, message)
  raise message unless condition
end

def gateway(docs)
  docs.find { |d| d['kind'] == 'Deployment' && d.dig('metadata', 'name') == 'urumi-gateway' }
end

%w[local prod].each do |environment|
  defaults = render(environment)
  default_env = gateway(defaults).dig('spec', 'template', 'spec', 'containers', 0, 'env')
  check(default_env.include?({'name' => 'CHAT_ENABLED', 'value' => 'false'}), 'Chat must default to disabled')
  check(default_env.none? { |e| e['name'] == 'OPENAI_API_KEY' }, 'Disabled chat must not require a credential')
  settings = {
    'gateway.chat.enabled' => true,
    'gateway.chat.model' => 'gpt-4.1-mini-2025-04-14',
    'gateway.chat.secretName' => 'urumi-chat-provider',
    'gateway.chat.secretKey' => 'api-key',
    'networkPolicy.gatewayEgress.chatProvider' => [{'cidr' => '203.0.113.10/32', 'ports' => [443]}]
  }
  configured = render(environment, settings)
  env = gateway(configured).dig('spec', 'template', 'spec', 'containers', 0, 'env')
  check(env.include?({'name' => 'CHAT_PROVIDER', 'value' => 'openai'}), 'Selected provider must reach gateway')
  check(env.include?({'name' => 'CHAT_MODEL', 'value' => 'gpt-4.1-mini-2025-04-14'}), 'Selected model must reach gateway')
  check(env.include?({'name' => 'OPENAI_API_KEY', 'valueFrom' => {'secretKeyRef' => {'name' => 'urumi-chat-provider', 'key' => 'api-key'}}}), 'Use required Secret reference only')
  policy = ->(docs) { docs.find { |d| d.dig('metadata', 'name') == 'urumi-gateway-egress' } }
  original_rules = policy.call(defaults).dig('spec', 'egress')
  expected_rule = {'to' => [{'ipBlock' => {'cidr' => '203.0.113.10/32'}}], 'ports' => [{'protocol' => 'TCP', 'port' => 443}]}
  check(policy.call(configured).dig('spec', 'egress') == original_rules + [expected_rule], 'Only exact provider HTTPS destination may be added')
  unaffected = ->(docs) { docs.reject { |d| ['urumi-gateway-egress', 'urumi-gateway'].include?(d.dig('metadata', 'name')) && ['Deployment', 'NetworkPolicy'].include?(d['kind']) } }
  check(unaffected.call(defaults) == unaffected.call(configured), 'Ingress, services, PVCs, RBAC and other workloads must remain identical')
  base_gateway = gateway(defaults)
  gateway(configured).dig('spec', 'template', 'spec', 'containers', 0)['env'] = default_env
  check(gateway(configured) == base_gateway, 'Only gateway environment may change')
  disabled = render(environment, settings.merge('gateway.chat.enabled' => false))
  check(policy.call(disabled) == policy.call(defaults), 'Disabled chat must not approve provider egress')
  [
    {'gateway.chat.provider' => 'other'}, {'gateway.chat.model' => 'bad model'},
    {'gateway.chat.secretName' => ''}, {'gateway.chat.secretKey' => ''},
    {'gateway.chat.apiKey' => 'must-never-be-a-value'},
    {'networkPolicy.gatewayEgress.chatProvider' => []},
    {'networkPolicy.gatewayEgress.chatProvider' => [{'cidr' => '0.0.0.0/0', 'ports' => [443]}]},
    {'networkPolicy.gatewayEgress.chatProvider' => [{'cidr' => '203.0.113.10/32', 'ports' => [80]}]},
    {'networkPolicy.gatewayEgress.chatProvider' => [{'namespace' => 'proxy', 'podLabels' => {'app' => 'proxy'}, 'ports' => [443]}]}
  ].each { |invalid| render(environment, settings.merge(invalid), valid: false) }
end
puts 'Chat configuration and scoped egress assertions passed for local and production'
