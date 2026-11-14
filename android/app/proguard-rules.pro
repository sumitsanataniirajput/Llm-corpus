# OkHttp ships its own consumer rules; these silence optional-dependency warnings.
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
# Tink (used by androidx.security) references optional annotations.
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**
