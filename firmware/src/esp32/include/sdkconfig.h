#pragma once

#include_next "sdkconfig.h"

#ifdef CONFIG_CAMERA_TASK_STACK_SIZE
#undef CONFIG_CAMERA_TASK_STACK_SIZE
#endif
#define CONFIG_CAMERA_TASK_STACK_SIZE 12288
