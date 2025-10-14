#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <esp_camera.h>

struct CameraHttpConfig {
	framesize_t frame_size;
	uint8_t jpeg_quality;
};

// Initializes camera HTTP streaming control.
void camera_http_init();

// Applies the currently stored camera configuration to the underlying sensor.
bool camera_http_sync_sensor();

// Starts the on-board HTTP snapshot server. Returns true on success.
bool camera_http_start();

// Stops the snapshot server if it is running.
void camera_http_stop();

// Returns true when the HTTP server is currently serving snapshots.
bool camera_http_is_running();

// Returns the active camera configuration.
CameraHttpConfig camera_http_get_config();

// Updates JPEG quality (10..63). Returns false when the value could not be applied.
bool camera_http_set_quality(uint8_t quality);

// Updates frame resolution. Returns false for unsupported frame sizes.
bool camera_http_set_resolution(framesize_t frame_size);

// Convenience helpers for converting between CLI strings and framesize codes.
bool camera_http_lookup_resolution(const char* name, framesize_t* out);
bool camera_http_set_resolution_by_name(const char* name);
const char* camera_http_resolution_name(framesize_t frame_size);

// Sets/returns the maximum framesize supported by the hardware buffers.
void camera_http_set_supported_max_resolution(framesize_t frame_size);
framesize_t camera_http_get_supported_max_resolution();

// Probes the sensor for the highest usable resolution and updates the limit.
framesize_t camera_http_detect_supported_max_resolution();
