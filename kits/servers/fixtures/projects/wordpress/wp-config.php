<?php
/**
 * Fixture: a WordPress site's live config. All values are fake.
 */

// ** Database settings ** //
define( 'DB_NAME', 'fake_database' );
define( 'DB_USER', 'fake_user' );
define( 'DB_PASSWORD', 'fake-password-not-real' );
define( 'DB_HOST', 'db.example.invalid' );
define( 'DB_CHARSET', 'utf8mb4' );
define( 'DB_COLLATE', '' );

define( 'AUTH_KEY', 'fake-auth-key-not-real' );

$table_prefix = 'wp_';

define( 'WP_DEBUG', false );

if ( ! defined( 'ABSPATH' ) ) {
	define( 'ABSPATH', __DIR__ . '/' );
}

require_once ABSPATH . 'wp-settings.php';
