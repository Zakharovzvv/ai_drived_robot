#pragma once

#include <IPAddress.h>

void wifi_init();
bool wifi_is_connected();
IPAddress wifi_local_ip();
