plugins {
    id("com.android.application")
}

android {
    namespace = "dev.airc.tmuxremote"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.airc.tmuxremote"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}
