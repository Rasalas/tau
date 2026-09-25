<?php
// Fixture: a TYPO3 site's live system settings. All values are fake.
return [
    'DB' => [
        'Connections' => [
            'Default' => [
                'charset' => 'utf8mb4',
                'dbname' => 'fake_database',
                'driver' => 'mysqli',
                'host' => 'db.example.invalid',
                'password' => 'fake-password-not-real',
                'port' => 3306,
                'user' => 'fake_user',
            ],
        ],
    ],
    'SYS' => [
        'encryptionKey' => 'fake-encryption-key-not-real',
        'sitename' => 'Fixture',
    ],
];
