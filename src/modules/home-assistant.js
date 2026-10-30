// Home Assistant setup YAML.
//
// Decaid's REST API is all Home Assistant needs — no MQTT broker, no custom
// integration — so the app ships the configuration as copy-paste text with the
// tablet's address already filled in. Endpoints track rest_v1.yml:
// GET /api/v1/machine/state (MachineSnapshot) and PUT /api/v1/machine/state/{newState}.

export function haYamlBlocks(host, port = '8080') {
    const base = `http://${host || 'DE1_TABLET_IP'}:${port}/api/v1`;
    return {
        rest: `# configuration.yaml  (or rest.yaml if you use !include)
rest:
  - resource: "${base}/machine/state"
    scan_interval: 60
    sensor:
      - name: DE1 State
        unique_id: de1_state
        value_template: "{{ value_json.state.state }}"
      - name: DE1 Grouphead Temperature
        unique_id: de1_grouptemp
        unit_of_measurement: "°C"
        device_class: temperature
        value_template: "{{ value_json.groupTemperature | default(0) | round(1) }}"
      - name: DE1 Steam Temperature
        unique_id: de1_steamtemp
        unit_of_measurement: "°C"
        device_class: temperature
        value_template: "{{ value_json.steamTemperature | default(0) | round(1) }}"`,

        command: `# rest_command.yaml
de1_turn_on:
  url: "${base}/machine/state/idle"
  method: PUT

de1_turn_off:
  url: "${base}/machine/state/sleeping"
  method: PUT`,

        // "on" is anything that is not asleep: the machine reports idle, heating,
        // espresso, steam and so on while awake, so testing for idle alone makes
        // the switch flip off mid-shot.
        template: `# template.yaml
template:
  - switch:
      - name: "DE1 Machine"
        unique_id: de1_machine
        state: "{{ states('sensor.de1_state') not in ['sleeping', 'unknown', 'unavailable'] }}"
        turn_on:
          action: rest_command.de1_turn_on
        turn_off:
          action: rest_command.de1_turn_off`
    };
}
