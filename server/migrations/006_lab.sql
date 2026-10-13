CREATE TABLE lab_tests (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(30) NOT NULL,
  name VARCHAR(150) NOT NULL,
  sample_type VARCHAR(40) NULL,
  unit VARCHAR(30) NULL,
  reference_range VARCHAR(60) NULL,
  critical_low DECIMAL(12,3) NULL,
  critical_high DECIMAL(12,3) NULL,
  price DECIMAL(12,2) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_lab_tests_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE lab_orders (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  patient_id INT UNSIGNED NOT NULL,
  doctor_id INT UNSIGNED NULL,
  priority ENUM('routine','urgent','stat') NOT NULL DEFAULT 'routine',
  status ENUM('registered','collected','resulted','cancelled') NOT NULL DEFAULT 'registered',
  is_critical TINYINT(1) NOT NULL DEFAULT 0,
  notes VARCHAR(255) NULL,
  collected_at DATETIME NULL,
  collected_by INT UNSIGNED NULL,
  resulted_at DATETIME NULL,
  resulted_by INT UNSIGNED NULL,
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_lab_orders_patient (patient_id),
  KEY idx_lab_orders_status (status),
  CONSTRAINT fk_lab_orders_patient FOREIGN KEY (patient_id) REFERENCES patients(id),
  CONSTRAINT fk_lab_orders_doctor FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE SET NULL,
  CONSTRAINT fk_lab_orders_collected_by FOREIGN KEY (collected_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_lab_orders_resulted_by FOREIGN KEY (resulted_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_lab_orders_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE lab_order_items (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  lab_order_id INT UNSIGNED NOT NULL,
  lab_test_id INT UNSIGNED NOT NULL,
  status ENUM('registered','collected','resulted','cancelled') NOT NULL DEFAULT 'registered',
  result_value DECIMAL(12,3) NULL,
  result_text VARCHAR(255) NULL,
  is_critical TINYINT(1) NOT NULL DEFAULT 0,
  resulted_at DATETIME NULL,
  UNIQUE KEY uq_lab_order_test (lab_order_id, lab_test_id),
  KEY idx_lab_items_test (lab_test_id),
  CONSTRAINT fk_lab_items_order FOREIGN KEY (lab_order_id) REFERENCES lab_orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_lab_items_test FOREIGN KEY (lab_test_id) REFERENCES lab_tests(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
