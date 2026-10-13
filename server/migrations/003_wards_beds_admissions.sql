CREATE TABLE wards (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  type VARCHAR(40) NOT NULL DEFAULT 'general',
  floor VARCHAR(20) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_wards_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE beds (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ward_id INT UNSIGNED NOT NULL,
  bed_number VARCHAR(20) NOT NULL,
  status ENUM('available','occupied','maintenance') NOT NULL DEFAULT 'available',
  daily_rate DECIMAL(12,2) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_beds_ward_number (ward_id, bed_number),
  KEY idx_beds_status (status),
  CONSTRAINT fk_beds_ward FOREIGN KEY (ward_id) REFERENCES wards(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE admissions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  patient_id INT UNSIGNED NOT NULL,
  bed_id INT UNSIGNED NOT NULL,
  doctor_id INT UNSIGNED NULL,
  admitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  discharged_at DATETIME NULL,
  status ENUM('admitted','discharged') NOT NULL DEFAULT 'admitted',
  reason VARCHAR(255) NULL,
  discharge_notes TEXT NULL,
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_adm_patient (patient_id),
  KEY idx_adm_bed (bed_id),
  KEY idx_adm_status (status),
  CONSTRAINT fk_adm_patient FOREIGN KEY (patient_id) REFERENCES patients(id),
  CONSTRAINT fk_adm_bed FOREIGN KEY (bed_id) REFERENCES beds(id),
  CONSTRAINT fk_adm_doctor FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE SET NULL,
  CONSTRAINT fk_adm_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
