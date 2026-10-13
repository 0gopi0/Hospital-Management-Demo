CREATE TABLE medicines (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  sku VARCHAR(40) NOT NULL,
  name VARCHAR(150) NOT NULL,
  generic_name VARCHAR(150) NULL,
  form VARCHAR(40) NULL,
  strength VARCHAR(40) NULL,
  unit_price DECIMAL(12,2) NOT NULL DEFAULT 0,
  stock_qty INT NOT NULL DEFAULT 0,
  reorder_level INT NOT NULL DEFAULT 10,
  batch_no VARCHAR(40) NULL,
  expiry_date DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_medicines_sku (sku),
  KEY idx_medicines_name (name),
  KEY idx_medicines_expiry (expiry_date),
  CONSTRAINT chk_medicine_stock CHECK (stock_qty >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE prescriptions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  patient_id INT UNSIGNED NOT NULL,
  doctor_id INT UNSIGNED NOT NULL,
  appointment_id INT UNSIGNED NULL,
  status ENUM('pending','dispensed','cancelled') NOT NULL DEFAULT 'pending',
  notes VARCHAR(255) NULL,
  dispensed_at DATETIME NULL,
  dispensed_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_rx_patient (patient_id),
  KEY idx_rx_doctor (doctor_id),
  KEY idx_rx_status (status),
  CONSTRAINT fk_rx_patient FOREIGN KEY (patient_id) REFERENCES patients(id),
  CONSTRAINT fk_rx_doctor FOREIGN KEY (doctor_id) REFERENCES doctors(id),
  CONSTRAINT fk_rx_appt FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL,
  CONSTRAINT fk_rx_dispensed_by FOREIGN KEY (dispensed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE prescription_items (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  prescription_id INT UNSIGNED NOT NULL,
  medicine_id INT UNSIGNED NOT NULL,
  quantity INT UNSIGNED NOT NULL,
  dosage VARCHAR(60) NULL,
  frequency VARCHAR(60) NULL,
  duration_days INT UNSIGNED NULL,
  instructions VARCHAR(255) NULL,
  KEY idx_rx_items_rx (prescription_id),
  KEY idx_rx_items_medicine (medicine_id),
  CONSTRAINT fk_rx_items_rx FOREIGN KEY (prescription_id) REFERENCES prescriptions(id) ON DELETE CASCADE,
  CONSTRAINT fk_rx_items_medicine FOREIGN KEY (medicine_id) REFERENCES medicines(id),
  CONSTRAINT chk_rx_item_qty CHECK (quantity > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
