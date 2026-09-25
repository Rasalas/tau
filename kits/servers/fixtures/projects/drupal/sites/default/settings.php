<?php
// Fixture: a Drupal site's live settings. All values are fake.

$databases['default']['default'] = [
  'database' => 'fake_database',
  'username' => 'fake_user',
  'password' => 'fake-password-not-real',
  'host' => 'db.example.invalid',
  'port' => '3306',
  'driver' => 'mysql',
  'prefix' => '',
];

$settings['hash_salt'] = 'fake-hash-salt-not-real';

# if (file_exists($app_root . '/' . $site_path . '/settings.local.php')) {
#   include $app_root . '/' . $site_path . '/settings.local.php';
# }
