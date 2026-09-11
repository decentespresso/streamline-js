// Canonical settings navigation structure — single source of truth for both
// the full settings page (settings.js) and the lightweight settings shell
// (settings-shell.js) that renders before the full module loads.
export const SETTINGS_TREE = {
    'quickadjustments': {
        name: 'Quick Adjustments',
        subcategories: [
            { id: 'flowmultiplier', name: 'Flow calibration', settingsCategory: 'flowmultiplier', i18nKey: 'Flow calibration' },
            { id: 'steam', name: 'Steam', settingsCategory: 'steam' },
            { id: 'hotwater', name: 'Hot Water', settingsCategory: 'hotwater' },
            { id: 'watertank', name: 'Water Tank', settingsCategory: 'watertank' },
            { id: 'flush', name: 'Flush', settingsCategory: 'flush' },
            { id: 'machineadvancedsettings', name: 'Machine Advanced Settings', settingsCategory: 'de1advanced' }
        ]
    },
    'bluetooth': {
        name: 'Connections',
        i18nKey: 'Connection',
        subcategories: [
            { id: 'ble_machine', name: '1. Machine', settingsCategory: 'ble_machine' },
            { id: 'ble_scale', name: '2. Scale', settingsCategory: 'ble_scale' }
        ]
    },
    'calibration': {
        name: 'Calibration',
        subcategories: [
            { id: 'defaultloadsettings', name: 'Default load settings', settingsCategory: 'calib_defaultload' },
            { id: 'refillkit',           name: 'Refill Kit',            settingsCategory: 'calib_refillkit' },
            { id: 'voltage',             name: 'Voltage',               settingsCategory: 'calib_voltage' },
            { id: 'fan',                 name: 'Fan',                   settingsCategory: 'calib_fan' },
            { id: 'steam',               name: 'Steam',                 settingsCategory: 'calib_steam' },
            { id: 'sensors',             name: 'Sensor Calibration',    settingsCategory: 'calib_sensors' },
            { id: 'loadcell',            name: 'Load Cells',            settingsCategory: 'calib_loadcell', i18nKey: 'Load Cells', bengleOnly: true }
        ]
    },
    'machine': {
        name: 'Machine',
        subcategories: [
            { id: 'usbchargermode', name: 'USB', settingsCategory: 'usbchargermode' },
            { id: 'cupwarmer', name: 'Cup Warmer', settingsCategory: 'cupwarmer', i18nKey: 'Cup Warmer', bengleOnly: true },
            { id: 'ledstrip', name: 'Lighting', settingsCategory: 'ledstrip', i18nKey: 'Lighting', bengleOnly: true },
            { id: 'machineinfo', name: 'Machine Information', settingsCategory: 'machineinfo', i18nKey: 'Machine Info' }
        ]
    },
    'maintenance': {
        name: 'Maintenance',
        subcategories: [
            { id: 'machinecleaning',  name: 'Clean',             settingsCategory: 'maint_cleaning' },
            { id: 'machinedescaling', name: 'Machine Descaling', settingsCategory: 'maint_descaling' },
            { id: 'transportmode',    name: 'Transport Mode',    settingsCategory: 'maint_airpurge' }
        ]
    },
    'skin': {
        name: 'Skin',
        subcategories: [
            { id: 'theme', name: 'Theme', settingsCategory: 'theme', i18nKey: 'Theme' },
            { id: 'skin1', name: 'Active Skin', settingsCategory: 'appearance', i18nKey: 'Active Skin' }
        ]
    },
    'language': {
        name: 'Language',
        subcategories: [
            { id: 'selectlanguage', name: 'Select Language', settingsCategory: 'language' },
        ]
    },
    'extensions': {
        name: 'Extensions',
        subcategories: [
            { id: 'extention1', name: 'Visualizer', settingsCategory: 'extensions' },
            { id: 'shotupload', name: 'Shot Uploader', settingsCategory: 'shotupload', i18nKey: 'Shot Uploader' },
            { id: 'extention2', name: 'Plugins', settingsCategory: 'plugins' },
            { id: 'dye2', name: 'DYE2', settingsCategory: 'dye2', i18nKey: 'DYE2' },
            { id: 'printtheshot', name: 'Print The Shot', settingsCategory: 'printtheshot', i18nKey: 'Print The Shot' }
        ]
    },
    'miscellaneous': {
        name: 'Miscellaneous',
        subcategories: [
            { id: 'reasettings', name: 'Decaid Settings', settingsCategory: 'rea' },
            { id: 'brightness', name: 'Brightness', settingsCategory: 'brightness' },
            { id: 'wakelock', name: 'Wake Lock', settingsCategory: 'wakelock' },
            { id: 'presence', name: 'Presence Detection', settingsCategory: 'presence' },
            { id: 'fontsize', name: 'Display Size', settingsCategory: 'fontsize' },
            { id: 'tempunit', name: 'Temperature', settingsCategory: 'tempunit', i18nKey: 'Temperature' },
            { id: 'screensaver', name: 'Screen Saver', settingsCategory: 'screensaver' },
            { id: 'keyboard-shortcuts', name: 'Keyboard Shortcuts', settingsCategory: 'keyboard_shortcuts' },
            { id: 'homeassistant', name: 'Home Assistant', settingsCategory: 'homeassistant', i18nKey: 'Home Assistant' }
        ]
    },
    'updates': {
        name: 'Updates',
        subcategories: [
            { id: 'firmwareupdate', name: 'Firmware Update', settingsCategory: 'firmware' }
        ]
    },
    'usermanual': {
        name: 'User Manual',
        subcategories: [
            { id: 'quickstart', name: 'Quick Start Guide', settingsCategory: 'quickstart', i18nKey: 'Quickstart Guide' },
            { id: 'talkdecent', name: 'Talk to Decent', settingsCategory: 'talkdecent' },
            { id: 'feedback', name: 'Send Feedback', settingsCategory: 'feedback' }
        ]
    }
};
