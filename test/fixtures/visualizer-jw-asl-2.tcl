profile_title {Visualizer/JW ASL 2}
author JW
profile_notes {An advanced spring lever profile.
Downloaded from Visualizer.}
beverage_type espresso
final_desired_shot_volume 32
final_desired_shot_weight 32
final_desired_shot_volume_advanced_count_start 0
tank_desired_water_temperature 0
settings_profile_type settings_2c
advanced_shot {
    {name infuse pump flow transition fast temperature 96 sensor coffee flow 8 pressure 0 seconds 10 weight 0 volume 0 exit_if 1 exit_type pressure_over exit_pressure_over 6 exit_pressure_under 0 exit_flow_over 0 exit_flow_under 0 max_flow_or_pressure 0 max_flow_or_pressure_range 0.6}
    {name {rise and hold} pump pressure transition fast temperature 96 sensor coffee flow 0 pressure 9 seconds 3 weight 0 volume 0 exit_if 0 exit_type pressure_over exit_pressure_over 9 exit_pressure_under 0 exit_flow_over 0 exit_flow_under 0 max_flow_or_pressure 0 max_flow_or_pressure_range 0.6}
    {name decline pump pressure transition smooth temperature 96 sensor coffee flow 0 pressure 6 seconds 30 weight 0 volume 0 exit_if 1 exit_type pressure_under exit_pressure_over 0 exit_pressure_under 6 exit_flow_over 0 exit_flow_under 0 max_flow_or_pressure 1.5 max_flow_or_pressure_range 0.6}
    {name {flow limit} pump flow transition smooth temperature 96 sensor coffee flow 1.5 pressure 0 seconds 30 weight 0 volume 0 exit_if 0 exit_type pressure_over exit_pressure_over 0 exit_pressure_under 0 exit_flow_over 0 exit_flow_under 0 max_flow_or_pressure 6 max_flow_or_pressure_range 0.6}
}
