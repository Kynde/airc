plugins {
    id("com.android.application")
}

// `git describe` captured at configuration time and baked into BuildConfig so the
// installed APK can report which build it is (the device has no git/repo). Falls back to
// a short hash when untagged and gains `-dirty` for a modified work tree; "unknown" when
// built outside a git tree. providers.exec runs from android-app/, inside the repo.
fun gitDescribe(): String = try {
    providers.exec {
        commandLine("git", "describe", "--tags", "--always", "--dirty")
    }.standardOutput.asText.get().trim().ifEmpty { "unknown" }
} catch (e: Exception) {
    "unknown"
}

android {
    namespace = "dev.airc.tmuxremote"
    compileSdk = 35

    buildFeatures {
        buildConfig = true
    }

    defaultConfig {
        applicationId = "dev.airc.tmuxremote"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("String", "GIT_DESCRIBE", "\"${gitDescribe()}\"")
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
