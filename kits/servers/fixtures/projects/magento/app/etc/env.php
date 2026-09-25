<?php
// Fixture: a Magento store's live env.php. All values are fake.
return [
    'backend' => [
        'frontName' => 'admin_fake'
    ],
    'crypt' => [
        'key' => 'fake-crypt-key-not-real'
    ],
    'db' => [
        'table_prefix' => '',
        'connection' => [
            'default' => [
                'host' => 'db.example.invalid',
                'dbname' => 'fake_database',
                'username' => 'fake_user',
                'password' => 'fake-password-not-real',
                'active' => '1'
            ]
        ]
    ],
    'MAGE_MODE' => 'production'
];
